const test = require('node:test');
const assert = require('node:assert/strict');
const { createBookingSync } = require('./booking-sync');

const calendars = ['court1', 'court2'];
const first = { eventId: 'source-event@google.com', calendarId: 'court1', court: 'Padel 1',
  customer: 'CC Booking: #990000001 On Court 1', startTime: '2027-09-15T00:00:00Z', endTime: '2027-09-15T01:00:00Z' };
const moved = { ...first, startTime: '2027-09-16T22:00:00Z', endTime: '2027-09-16T23:00:00Z' };

function harness(initial) {
  let clock = Date.parse('2026-10-31T12:00:00Z');
  let state = initial || { version: 1, jobs: {} };
  let disk;
  let serial = 0;
  const blocks = new Map();
  const actions = [];
  const faults = {};
  const missing = () => Object.assign(new Error('API 404: CLOSED_DATE_NOT_FOUND'), { status: 404 });
  const deps = {
    getStore: () => state, persist: async () => { if (faults.persist) throw faults.persist; disk = JSON.parse(JSON.stringify(state)); },
    calendars, now: () => clock,
    readBlock: async id => { actions.push(['read', id]); if (faults.onRead) await faults.onRead(id); if (faults.read) throw faults.read; if (!blocks.has(id)) throw missing(); return structuredClone(blocks.get(id)); },
    removeBlock: async id => { actions.push(['delete', id]); if (faults.remove) throw faults.remove; blocks.delete(id); },
    createBlock: async (booking, checkpoint) => {
      actions.push(['create', booking.startTime]);
      if (faults.create) throw faults.create;
      const id = 'block-' + (++serial);
      blocks.set(id, { id, name: 'CatchCorner - ' + booking.customer,
        resource_ids: [booking.court === 'Padel 1' ? '1f900b5d-f99d-4b17-9a8a-1ceb28be5299' : '6ea04658-e7db-456a-beef-efc9c91fa7b0'],
        start: booking.startTime.slice(0,19), end: booking.endTime.slice(0,19) });
      if (faults.beforeCheckpoint) await faults.beforeCheckpoint();
      await checkpoint({ id });
      if (faults.afterCheckpoint) await faults.afterCheckpoint();
      return { id };
    },
  };
  let sync = createBookingSync(deps);
  return {
    get sync() { return sync; }, blocks, actions, faults,
    get state() { return state; },
    advance(ms = 120000) { clock += ms; },
    restart() { state = JSON.parse(JSON.stringify(disk)); sync = createBookingSync(deps); },
    async snapshot(events, reservations = []) {
      clock += 1000;
      return sync.acceptSnapshot({ schemaVersion: 1, complete: true, generatedAt: new Date(clock).toISOString(),
        windowStart: '2026-10-01T00:00:00Z', windowEnd: '2027-12-01T00:00:00Z', calendars, events, reservations });
    },
    async drain() { for (let i = 0; i < 15; i++) if (!await sync.processNext()) break; },
  };
}

test('same calendar ID rescheduled: verify new block before deleting old block', async () => {
  const h = harness();
  await h.snapshot([first]); await h.drain();
  const oldId = [...h.blocks.keys()][0];
  h.actions.length = 0;
  await h.snapshot([moved]); await h.drain();
  assert.equal(h.blocks.size, 1);
  const current = [...h.blocks.values()][0];
  assert.equal(current.start, moved.startTime.slice(0,19));
  const createIndex = h.actions.findIndex(a => a[0] === 'create');
  const readNewIndex = h.actions.findIndex(a => a[0] === 'read' && a[1] !== oldId);
  const deleteOldIndex = h.actions.findIndex(a => a[0] === 'delete' && a[1] === oldId);
  assert.ok(createIndex >= 0 && readNewIndex > createIndex && deleteOldIndex > readNewIndex);
  assert.equal(h.sync.summary().issues.length, 0);
});

test('a continuing conflict survives the next calendar scan so its alert can be delivered', async () => {
  const h = harness();
  const reservation = { ...moved, eventId: 'paid@google.com', customer: '(Playtomic) Paid booking' };
  await h.snapshot([first]); await h.drain();
  await h.snapshot([moved], [reservation]); await h.drain();
  assert.equal(h.sync.summary().issues[0].code, 'reservation_conflict');
  // Apps Script reads issues immediately after delivering each complete snapshot.
  await h.snapshot([moved], [reservation]);
  assert.equal(h.sync.summary().issues[0]?.code, 'reservation_conflict');
  assert.equal(h.sync.summary().entries[0].status, 'conflict');
  await h.snapshot([moved], []); await h.drain();
  assert.equal(h.sync.summary().issues.length, 0);
  assert.equal(h.blocks.size, 1);
});

test('recurring occurrences with one iCal UID sync independently and a moved instance keeps its identity', async () => {
  const h = harness();
  const one = { ...first, customer: 'Recurring lesson', eventId: 'series@google.com',
    occurrenceId: 'series_20270915T000000Z', recurringEventId: 'series', originalStartTime: first.startTime };
  const two = { ...one, startTime: '2027-09-22T00:00:00Z', endTime: '2027-09-22T01:00:00Z',
    occurrenceId: 'series_20270922T000000Z', originalStartTime: '2027-09-22T00:00:00Z' };
  await h.snapshot([one, two]); await h.drain();
  assert.equal(h.sync.summary().issues.length, 0, 'different recurrence dates are not conflicting revisions');
  assert.equal(h.blocks.size, 2);
  const keys = h.sync.summary().entries.map(entry => entry.key).sort();
  await h.snapshot([{ ...one, ...{ startTime: moved.startTime, endTime: moved.endTime } }, two]); await h.drain();
  assert.deepEqual(h.sync.summary().entries.map(entry => entry.key).sort(), keys);
  assert.equal(h.blocks.size, 2, 'only the moved occurrence is replaced');
  assert.ok([...h.blocks.values()].some(block => block.start === two.startTime.slice(0, 19)));
});

test('unchanged snapshots are idempotent; stale snapshots cannot undo a move', async () => {
  const h = harness();
  await h.snapshot([moved]); await h.drain();
  await h.snapshot([moved]); await h.drain();
  const accepted = await h.sync.acceptSnapshot({ schemaVersion: 1, complete: true,
    generatedAt: '2026-10-31T11:00:00Z', windowStart: '2026-10-01T00:00:00Z',
    windowEnd: '2027-12-01T00:00:00Z', calendars, events: [first], reservations: [] });
  assert.equal(accepted.stale, true);
  await h.drain();
  assert.equal(h.actions.filter(action => action[0] === 'create').length, 1);
  assert.equal([...h.blocks.values()][0].start, moved.startTime.slice(0,19));
});

test('the former ambiguous series hold is superseded only after occurrence identities arrive', async () => {
  const h = harness();
  const one = { ...first, eventId: 'series@google.com', customer: 'Recurring lesson' };
  const two = { ...one, startTime: moved.startTime, endTime: moved.endTime };
  await h.snapshot([one, two]); await h.drain();
  assert.equal(h.sync.summary().issues[0].code, 'source_conflict');
  await h.snapshot([one, two].map((event, index) => ({ ...event, occurrenceId: 'instance-' + index,
    recurringEventId: 'series', originalStartTime: event.startTime }))); await h.drain();
  assert.equal(h.sync.summary().issues.length, 0);
  assert.equal(h.blocks.size, 2);
  assert.equal(h.state.bookingSync.entries['event:series@google.com'].status, 'superseded');
  await h.snapshot([one, two].map((event, index) => ({ ...event, occurrenceId: 'instance-' + index,
    recurringEventId: 'series', originalStartTime: event.startTime }))); await h.drain();
  assert.equal(h.sync.summary().issues.length, 0, 'the superseded series must not become a missing-source alert');
});

test('an existing verified series block is transferred to its occurrence without a duplicate create', async () => {
  const h = harness();
  const one = { ...first, eventId: 'series@google.com', customer: 'Recurring lesson' };
  await h.snapshot([one]); await h.drain();
  const originalId = [...h.blocks.keys()][0];
  const two = { ...one, startTime: moved.startTime, endTime: moved.endTime };
  await h.snapshot([one, two].map((event, index) => ({ ...event, occurrenceId: 'instance-' + index,
    recurringEventId: 'series', originalStartTime: event.startTime }))); await h.drain();
  assert.equal(h.blocks.size, 2);
  assert.ok(h.blocks.has(originalId));
  assert.equal(h.actions.filter(action => action[0] === 'create').length, 2);
  assert.equal(h.sync.summary().issues.length, 0);
});

test('recurrence migration never discards an uncertain create intent', async () => {
  const h = harness();
  const one = { ...first, eventId: 'series@google.com', customer: 'Recurring lesson' };
  h.faults.create = new Error('Connection lost after possible write');
  await h.snapshot([one]); await h.drain();
  delete h.faults.create;
  await h.snapshot([{ ...one, occurrenceId: 'instance', recurringEventId: 'series', originalStartTime: one.startTime }]);
  await h.drain();
  assert.ok(h.state.bookingSync.entries['event:series@google.com'].createIntent);
  assert.equal(h.actions.filter(action => action[0] === 'create').length, 1);
  assert.ok(h.sync.summary().issues.some(issue => issue.code === 'recurrence_migration_review'));
});

test('incomplete occurrence metadata fails closed rather than inventing a time-based identity', async () => {
  const h = harness();
  await assert.rejects(h.snapshot([{ ...first, occurrenceId: 'instance-without-origin' }]), /occurrence identity/);
  assert.equal(h.actions.length, 0);
});

test('legacy series jobs belong to exactly one occurrence, not every session sharing their alias', async () => {
  const one = { ...first, customer: 'Recurring lesson', eventId: 'series@google.com',
    occurrenceId: 'first-instance', recurringEventId: 'series', originalStartTime: first.startTime };
  const two = { ...one, occurrenceId: 'second-instance', originalStartTime: moved.startTime,
    startTime: moved.startTime, endTime: moved.endTime };
  const h = harness({ version: 1, jobs: { legacy: { id: 'legacy', sourceId: 'series', status: 'succeeded',
    attempts: 1, blockId: 'legacy-block', booking: { ...first, customer: 'Recurring lesson' },
    result: { name: 'CatchCorner - Recurring lesson' } } } });
  h.blocks.set('legacy-block', { id: 'legacy-block', name: 'CatchCorner - Recurring lesson',
    resource_ids: ['1f900b5d-f99d-4b17-9a8a-1ceb28be5299'], start: first.startTime.slice(0, 19), end: first.endTime.slice(0, 19) });
  await h.snapshot([one, two]); await h.drain();
  assert.equal(h.blocks.size, 2);
  assert.ok(h.blocks.has('legacy-block'));
  assert.equal(h.actions.filter(action => action[0] === 'create').length, 1);
  assert.equal(h.actions.filter(action => action[0] === 'delete').length, 0);
});

test('a recurring cross-court move retains its original identity and leaves the sibling block unchanged', async () => {
  const h = harness();
  const one = { ...first, customer: 'Recurring lesson', eventId: 'series@google.com',
    occurrenceId: 'instance-one', recurringEventId: 'series', originalStartTime: first.startTime };
  const two = { ...one, occurrenceId: 'instance-two', originalStartTime: moved.startTime,
    startTime: moved.startTime, endTime: moved.endTime };
  await h.snapshot([one, two]); await h.drain();
  const sibling = [...h.blocks.values()].find(block => block.start === two.startTime.slice(0, 19));
  await h.snapshot([{ ...one, court: 'Padel 2', calendarId: 'court2', occurrenceId: 'provider-moved-id',
    startTime: '2027-09-15T00:30:00Z', endTime: '2027-09-15T01:30:00Z' }, two]); await h.drain();
  assert.equal(h.blocks.size, 2);
  assert.deepEqual(h.blocks.get(sibling.id), sibling);
  assert.ok([...h.blocks.values()].some(block => block.resource_ids[0] === '6ea04658-e7db-456a-beef-efc9c91fa7b0'));
  assert.equal(h.sync.summary().issues.length, 0);
});

test('a definite replacement rejection keeps the original and retries safely', async () => {
  const h = harness();
  await h.snapshot([first]); await h.drain();
  const oldId = [...h.blocks.keys()][0];
  h.faults.create = Object.assign(new Error('API 429: retry later'), { safeToRetry: true });
  await h.snapshot([moved]); await h.drain();
  assert.ok(h.blocks.has(oldId));
  assert.equal(h.blocks.size, 1);
  assert.equal(h.sync.summary().issues.length, 1);
  delete h.faults.create;
  h.advance(); await h.snapshot([moved]); await h.drain();
  assert.equal(h.blocks.size, 1);
  assert.equal(h.sync.summary().issues.length, 0);
});

test('cleanup retry survives restart without creating a second replacement', async () => {
  const h = harness();
  await h.snapshot([first]); await h.drain();
  h.faults.remove = new Error('API 503: delete temporarily unavailable');
  await h.snapshot([moved]); await h.drain();
  assert.equal(h.blocks.size, 2);
  h.restart(); delete h.faults.remove;
  h.advance(); await h.snapshot([moved]); await h.drain();
  assert.equal(h.blocks.size, 1);
  assert.equal(h.actions.filter(action => action[0] === 'create').length, 2);
  assert.equal(h.sync.summary().issues.length, 0);
});

test('restart after a captured create ID resumes verification, not creation', async () => {
  const h = harness();
  await h.snapshot([first]); await h.drain();
  h.faults.afterCheckpoint = async () => { throw new Error('process interrupted after checkpoint'); };
  await h.snapshot([moved]); await h.drain();
  assert.equal(h.blocks.size, 2);
  h.restart(); delete h.faults.afterCheckpoint;
  h.advance(); await h.snapshot([moved]); await h.drain();
  assert.equal(h.blocks.size, 1);
  assert.equal(h.actions.filter(action => action[0] === 'create').length, 2);
});

test('an uncertain create outcome requires review and never retries a blind write', async () => {
  const h = harness();
  await h.snapshot([first]); await h.drain();
  h.faults.create = new Error('connection dropped after sending the request');
  await h.snapshot([moved]); await h.drain();
  assert.equal(h.sync.summary().issues[0].code, 'uncertain_create');
  const attempts = h.actions.filter(action => action[0] === 'create').length;
  delete h.faults.create; h.restart(); h.advance();
  await h.snapshot([moved]); await h.drain();
  assert.equal(h.actions.filter(action => action[0] === 'create').length, attempts);
  assert.equal(h.blocks.size, 1);
});

test('A to B to C during creation ends at C and cleans A and B only afterward', async () => {
  const h = harness();
  await h.snapshot([first]); await h.drain();
  const latest = { ...moved, startTime: '2027-09-17T20:00:00Z', endTime: '2027-09-17T21:00:00Z' };
  h.faults.afterCheckpoint = async () => {
    delete h.faults.afterCheckpoint;
    await h.snapshot([latest]);
  };
  await h.snapshot([moved]); await h.drain();
  assert.equal(h.blocks.size, 1);
  assert.equal([...h.blocks.values()][0].start, latest.startTime.slice(0,19));
  assert.equal(h.actions.filter(action => action[0] === 'create').length, 3);
});

test('a new paid reservation prevents a replacement; removing the conflict resumes it', async () => {
  const h = harness();
  await h.snapshot([first]); await h.drain();
  const reservation = { ...moved, eventId: 'playtomic-paid', customer: 'Customer (Playtomic)' };
  await h.snapshot([moved], [reservation]); await h.drain();
  assert.equal(h.sync.summary().issues[0].code, 'reservation_conflict');
  assert.equal(h.blocks.size, 1);
  assert.equal(h.actions.filter(action => action[0] === 'create').length, 1);
  await h.snapshot([moved]); await h.drain();
  assert.equal(h.blocks.size, 1);
  assert.equal([...h.blocks.values()][0].start, moved.startTime.slice(0,19));
});

test('a changed original block is never deleted based on its stored ID alone', async () => {
  const h = harness();
  await h.snapshot([first]); await h.drain();
  [...h.blocks.values()][0].name = 'Edited by a staff member';
  await h.snapshot([moved]); await h.drain();
  assert.equal(h.sync.summary().issues[0].code, 'ownership_mismatch');
  assert.equal(h.blocks.size, 2);
  assert.equal(h.actions.filter(action => action[0] === 'delete').length, 0);
});

test('if replacement disappears before cleanup, the original remains protected', async () => {
  const h = harness();
  await h.snapshot([first]); await h.drain();
  const oldId = [...h.blocks.keys()][0];
  let newReads = 0;
  h.faults.onRead = async id => {
    if (id !== oldId && ++newReads === 2) h.blocks.delete(id);
  };
  await h.snapshot([moved]); await h.drain();
  assert.ok(h.blocks.has(oldId));
  assert.equal(h.actions.filter(action => action[0] === 'delete' && action[1] === oldId).length, 0);
});

test('missing source events are flagged after confirmation; never blindly cancelled', async () => {
  const h = harness();
  await h.snapshot([first]); await h.drain();
  await h.snapshot([]); h.advance(11 * 60000); await h.snapshot([]); await h.drain();
  assert.equal(h.sync.summary().issues[0].code, 'missing_source');
  assert.equal(h.blocks.size, 1);
  assert.equal(h.actions.filter(action => action[0] === 'delete').length, 0);
  await h.snapshot([first]); await h.drain();
  assert.equal(h.sync.summary().issues.length, 0);
});

test('an incomplete calendar snapshot fails closed before changing desired state', async () => {
  const h = harness();
  await h.snapshot([first]); await h.drain();
  const before = structuredClone(h.state);
  await assert.rejects(h.sync.acceptSnapshot({ schemaVersion: 1, complete: true,
    generatedAt: '2026-10-31T12:05:00Z', windowStart: '2026-10-01T00:00:00Z',
    windowEnd: '2027-12-01T00:00:00Z', calendars: ['court1'], events: [], reservations: [] }), /Incomplete/);
  assert.deepEqual(h.state, before);
});

test('same-court overlapping moves and cross-court moves keep one final block', async () => {
  const h = harness();
  await h.snapshot([first]); await h.drain();
  await h.snapshot([{ ...first, startTime: '2027-09-15T00:30:00Z', endTime: '2027-09-15T01:30:00Z' }]); await h.drain();
  assert.equal(h.blocks.size, 1);
  await h.snapshot([{ ...moved, eventId: 'new-calendar-event@google.com', calendarId: 'court2', court: 'Padel 2' }]); await h.drain();
  assert.equal(h.blocks.size, 1);
  assert.deepEqual([...h.blocks.values()][0].resource_ids, ['6ea04658-e7db-456a-beef-efc9c91fa7b0']);
});

test('legacy successful jobs are adopted and replaced without duplicate initial creation', async () => {
  const legacyBooking = { ...first, id: 'source-event' };
  const name = 'CatchCorner - ' + first.customer;
  const h = harness({ version: 1, jobs: { legacy: { id: 'legacy', sourceId: 'source-event', status: 'succeeded',
    booking: legacyBooking, blockId: 'legacy-block', result: { name } } } });
  h.blocks.set('legacy-block', { name, resource_ids: ['1f900b5d-f99d-4b17-9a8a-1ceb28be5299'],
    start: first.startTime.slice(0,19), end: first.endTime.slice(0,19) });
  await h.snapshot([first]); await h.drain();
  assert.equal(h.actions.filter(action => action[0] === 'create').length, 0);
  await h.snapshot([moved]); await h.drain();
  assert.equal(h.blocks.size, 1);
  assert.equal(h.state.jobs.legacy.status, 'replaced');
  assert.equal(h.state.jobs.legacy.syncOwner, 'CC-990000001');
});

test('a stale calendar snapshot cannot drive new writes', async () => {
  const h = harness();
  await h.snapshot([first]); h.advance(21 * 60000); await h.drain();
  assert.equal(h.blocks.size, 0);
  assert.equal(h.sync.summary().snapshotStale, true);
  await h.snapshot([first]); await h.drain();
  assert.equal(h.blocks.size, 1);
});

test('legacy truncated-ID collisions are held for review', async () => {
  const h = harness();
  const a = { ...first, customer: 'Manual one', eventId: 'abcdefghijklmnopqrst-1' };
  const b = { ...moved, customer: 'Manual two', eventId: 'abcdefghijklmnopqrst-2' };
  await h.snapshot([a, b]); await h.drain();
  assert.equal(h.blocks.size, 0);
  assert.equal(h.sync.summary().issues.length, 2);
  assert.ok(h.sync.summary().issues.every(issue => issue.code === 'source_conflict'));
});

test('uncertain create recovery adopts only a verified block with the exact saved marker', async () => {
  const h = harness();
  await h.snapshot([first]); await h.drain();
  h.faults.create = new Error('connection closed after sending');
  await h.snapshot([moved]); await h.drain();
  const intent = h.sync.summary().entries[0].createIntent;
  h.blocks.set('foreign', { name: 'Another customer', resource_ids: ['1f900b5d-f99d-4b17-9a8a-1ceb28be5299'],
    start: moved.startTime.slice(0,19), end: moved.endTime.slice(0,19) });
  await assert.rejects(h.sync.recoverCreate('CC-990000001', 'foreign'), /Ownership/);
  h.blocks.set('recovered', { name: 'CatchCorner - ' + intent.booking.customer,
    resource_ids: ['1f900b5d-f99d-4b17-9a8a-1ceb28be5299'], start: moved.startTime.slice(0,19), end: moved.endTime.slice(0,19) });
  delete h.faults.create;
  await h.sync.recoverCreate('CC-990000001', 'recovered'); await h.drain();
  assert.equal(h.actions.filter(action => action[0] === 'create').length, 2);
  assert.ok(h.blocks.has('foreign'));
  assert.ok(h.blocks.has('recovered'));
  assert.equal(h.blocks.size, 2, 'only the original owned block was cleaned up');
});

test('explicit cleanup requires source absence and cannot retire a live booking', async () => {
  const h = harness();
  await h.snapshot([first]); await h.drain();
  await assert.rejects(h.sync.retireSource('CC-990000001'), /source is absent/);
  assert.equal(h.blocks.size, 1);
  await h.snapshot([]);
  await h.sync.retireSource('CC-990000001');
  assert.equal(h.blocks.size, 0);
  assert.equal(h.sync.summary().counts.retired, 1);
  h.advance(11 * 60000); await h.snapshot([]); await h.drain();
  assert.equal(h.sync.summary().issues.length, 0);
  await h.snapshot([first]); await h.drain();
  assert.equal(h.blocks.size, 0, 'a stale reappearing source cannot recreate an explicitly retired test');
  assert.equal(h.sync.summary().issues[0].code, 'retired_source_reappeared');
});

test('past reschedule drift is audited without creating a past block', async () => {
  const original = { ...first, startTime: '2026-10-27T00:00:00Z', endTime: '2026-10-27T01:00:00Z' };
  const updated = { ...moved, startTime: '2026-10-28T22:00:00Z', endTime: '2026-10-28T23:00:00Z' };
  const h = harness({ version: 1, jobs: { legacy: { id: 'legacy', sourceId: 'source-event', status: 'succeeded',
    booking: original, blockId: 'legacy-block', result: { name: 'CatchCorner - ' + original.customer } } } });
  await h.snapshot([updated]); await h.drain();
  assert.equal(h.actions.length, 0);
  assert.equal(h.sync.summary().historical.length, 1);
});

test('preview reports the planned reschedule without mutating real state or touching Playtomic', async () => {
  const h = harness();
  await h.snapshot([first]); await h.drain();
  const before = structuredClone(h.state);
  const actions = h.actions.length;
  const report = await h.sync.previewSnapshot({ schemaVersion: 1, complete: true,
    generatedAt: '2026-10-31T12:02:00Z', windowStart: '2026-10-01T00:00:00Z',
    windowEnd: '2027-12-01T00:00:00Z', calendars, events: [moved], reservations: [] });
  assert.equal(report.dryRun, true);
  assert.equal(report.plannedCounts.replace, 1);
  assert.deepEqual(h.state, before);
  assert.equal(h.actions.length, actions);
});

test('a manual booking keeps its full identity when moved between court calendars', async () => {
  const h = harness();
  const manual = { ...first, customer: 'Manual booking' };
  await h.snapshot([manual]); await h.drain();
  await h.snapshot([{ ...manual, court: 'Padel 2', calendarId: 'court2' }]); await h.drain();
  assert.equal(h.sync.summary().entries.length, 1);
  assert.equal(h.blocks.size, 1);
  assert.deepEqual([...h.blocks.values()][0].resource_ids, ['6ea04658-e7db-456a-beef-efc9c91fa7b0']);
});

test('a failed snapshot persistence cannot trigger writes from unacknowledged state', async () => {
  const h = harness();
  h.faults.persist = new Error('disk write unavailable');
  await assert.rejects(h.snapshot([first]), /disk write/);
  assert.equal(h.sync.summary().persistenceFault, true);
  assert.equal(await h.sync.processNext(), false);
  assert.equal(h.actions.length, 0);
  delete h.faults.persist;
  await h.snapshot([first]); await h.drain();
  assert.equal(h.blocks.size, 1);
});

test('write before failed checkpoint persistence becomes uncertain after restart, without duplicates', async () => {
  const h = harness();
  await h.snapshot([first]); await h.drain();
  h.faults.beforeCheckpoint = async () => { h.faults.persist = new Error('disk write unavailable'); };
  await h.snapshot([moved]);
  await assert.rejects(h.drain(), /disk write/);
  assert.equal(h.blocks.size, 2);
  delete h.faults.persist; delete h.faults.beforeCheckpoint; h.restart();
  await h.drain();
  assert.equal(h.sync.summary().issues[0].code, 'uncertain_create');
  assert.equal(h.actions.filter(action => action[0] === 'create').length, 2);
});

test('100 successive revisions with retryable faults finish with exactly one current block', async () => {
  const h = harness();
  for (let i = 0; i < 100; i++) {
    const start = Date.parse('2027-09-15T10:00:00Z') + i * 15 * 60000;
    const event = { ...first, court: i % 2 ? 'Padel 2' : 'Padel 1', calendarId: i % 2 ? 'court2' : 'court1',
      startTime: new Date(start).toISOString(), endTime: new Date(start + 3600000).toISOString() };
    if (i % 7 === 0) h.faults.create = Object.assign(new Error('API 429'), { safeToRetry: true });
    if (i % 11 === 0) h.faults.remove = new Error('API 503');
    await h.snapshot([event]); await h.drain();
    delete h.faults.create; delete h.faults.remove;
    h.advance(); await h.snapshot([event]); await h.drain();
    assert.equal(h.blocks.size, 1, 'exactly one block after revision ' + i);
    assert.equal([...h.blocks.values()][0].start, event.startTime.slice(0,19));
    assert.equal(h.sync.summary().issues.length, 0);
  }
});

test('an attempted legacy job with no saved result is held for explicit recovery', async () => {
  const h = harness({ version: 1, jobs: { legacy: { id: 'legacy', sourceId: 'source-event', status: 'queued',
    attempts: 2, booking: first, blockId: null, result: null, lastError: 'request timeout' } } });
  await h.snapshot([moved]); await h.drain();
  assert.equal(h.actions.length, 0);
  assert.equal(h.sync.summary().issues[0].code, 'uncertain_legacy_create');
  h.blocks.set('legacy-recovered', { name: 'CatchCorner - ' + first.customer,
    resource_ids: ['1f900b5d-f99d-4b17-9a8a-1ceb28be5299'], start: first.startTime.slice(0,19), end: first.endTime.slice(0,19) });
  await h.sync.recoverCreate('CC-990000001', 'legacy-recovered'); await h.drain();
  assert.equal(h.blocks.size, 1);
  assert.equal([...h.blocks.values()][0].start, moved.startTime.slice(0,19));
  assert.equal(h.state.jobs.legacy.status, 'replaced');
});

test('an ambiguous source arriving during a write stays held, with no cleanup', async () => {
  const h = harness();
  await h.snapshot([first]); await h.drain();
  h.faults.afterCheckpoint = async () => {
    delete h.faults.afterCheckpoint;
    await h.snapshot([first, moved]);
  };
  await h.snapshot([moved]); await h.drain();
  assert.equal(h.sync.summary().issues[0].code, 'source_conflict');
  assert.equal(h.sync.summary().entries[0].status, 'source_conflict');
  assert.equal(h.blocks.size, 2);
  assert.equal(h.actions.filter(action => action[0] === 'delete').length, 0);
});

test('a paid conflict arriving during a write prevents obsolete-block cleanup', async () => {
  const h = harness();
  await h.snapshot([first]); await h.drain();
  h.faults.afterCheckpoint = async () => {
    delete h.faults.afterCheckpoint;
    await h.snapshot([moved], [{ ...moved, eventId: 'paid', customer: 'Paid booking (Playtomic)' }]);
  };
  await h.snapshot([moved]); await h.drain();
  assert.equal(h.sync.summary().issues[0].code, 'reservation_conflict');
  assert.equal(h.blocks.size, 2);
  assert.equal(h.actions.filter(action => action[0] === 'delete').length, 0);
});

test('operator pause persists across restart and holds cleanup of an in-flight replacement', async () => {
  const h = harness();
  await h.snapshot([first]); await h.drain();
  h.faults.afterCheckpoint = async () => {
    delete h.faults.afterCheckpoint;
    await h.sync.setPaused(true);
  };
  await h.snapshot([moved]); await h.drain();
  assert.equal(h.blocks.size, 2);
  assert.equal(h.actions.filter(action => action[0] === 'delete').length, 0);
  h.restart();
  assert.equal(h.sync.summary().paused, true);
  assert.equal(await h.sync.processNext(), false);
  await h.sync.setPaused(false); await h.drain();
  assert.equal(h.blocks.size, 1);
  assert.equal(h.sync.summary().issues.length, 0);
});
