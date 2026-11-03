const crypto = require('node:crypto');

const RESOURCES = {
  'Padel 1': '1f900b5d-f99d-4b17-9a8a-1ceb28be5299',
  'Padel 2': '6ea04658-e7db-456a-beef-efc9c91fa7b0',
};
const MINUTE = 60_000;
const iso = value => new Date(value).toISOString();
const fingerprint = booking => `${booking.court}|${iso(booking.startTime)}|${iso(booking.endTime)}`;
const overlaps = (a, b) => a.court === b.court && Date.parse(a.startTime) < Date.parse(b.endTime) &&
  Date.parse(b.startTime) < Date.parse(a.endTime);
const ccId = title => String(title || '').match(/\bCC Booking:\s*#(\d+)\b/i)?.[1] || null;
const missingBlock = error => /API 404:.*CLOSED_DATE_NOT_FOUND/.test(String(error?.message || error));
const copy = value => JSON.parse(JSON.stringify(value));

function matchingBlock(booking, block) {
  return block && Array.isArray(block.resource_ids) && block.resource_ids.length === 1 &&
    block.resource_ids[0] === RESOURCES[booking.court] &&
    String(block.start || '').slice(0, 19) === iso(booking.startTime).slice(0, 19) &&
    String(block.end || '').slice(0, 19) === iso(booking.endTime).slice(0, 19);
}

function normalizeEvent(event, calendarIds) {
  if (!event || typeof event.eventId !== 'string' || !event.eventId || event.eventId.length > 300 ||
      !calendarIds.includes(event.calendarId) || !RESOURCES[event.court] ||
      calendarIds.indexOf(event.calendarId) !== Number(event.court.slice(-1)) - 1 ||
      !Number.isFinite(Date.parse(event.startTime)) || !Number.isFinite(Date.parse(event.endTime)) ||
      Date.parse(event.endTime) <= Date.parse(event.startTime)) throw new Error('Invalid calendar event');
  const customer = String(event.customer || 'External booking').slice(0, 180);
  const bookingNumber = ccId(customer);
  const recurring = [event.occurrenceId, event.recurringEventId, event.originalStartTime].some(value => value !== undefined);
  if (recurring && (typeof event.occurrenceId !== 'string' || !event.occurrenceId || event.occurrenceId.length > 300 ||
      typeof event.recurringEventId !== 'string' || !event.recurringEventId || event.recurringEventId.length > 300 ||
      !Number.isFinite(Date.parse(event.originalStartTime)))) throw new Error('Invalid calendar event occurrence identity');
  return {
    id: recurring ? `event:${event.eventId}:occurrence:${iso(event.originalStartTime)}` :
      bookingNumber ? `CC-${bookingNumber}` : `event:${event.eventId}`,
    ...(recurring ? { occurrenceId: event.occurrenceId, recurringEventId: event.recurringEventId,
      originalStartTime: iso(event.originalStartTime) } : {}),
    eventId: event.eventId, calendarId: event.calendarId,
    legacyId: event.eventId.replace('@google.com', '').slice(0, 20),
    customer, court: event.court, startTime: iso(event.startTime), endTime: iso(event.endTime),
  };
}

/** One durable module owns revision selection, replacement, verification and cleanup. */
function createBookingSync(deps) {
  const now = deps.now || Date.now;
  const maxAttempts = deps.maxAttempts || 20;
  let running = false;
  let accepting = false;
  let persistenceFault = false;
  let administrativeAction = false;
  function state() {
    const store = deps.getStore();
    if (!store.bookingSync) store.bookingSync = { schemaVersion: 1, entries: {}, snapshotAt: null, reservations: [] };
    return store.bookingSync;
  }
  const stamp = () => new Date(now()).toISOString();
  function migrate(entry) {
    for (const job of Object.values(deps.getStore().jobs || {})) {
      const jobNumber = ccId(job.booking?.customer);
      const belongs = entry.key.startsWith('CC-') ? entry.key === `CC-${jobNumber}` :
        entry.aliases.includes(job.sourceId);
      if (!belongs || (job.syncOwner && job.syncOwner !== entry.key)) continue;
      // A legacy series alias is shared by every occurrence. Only the matching
      // original occurrence (or exact persisted interval) may adopt its job.
      if (entry.desired.originalStartTime && fingerprint(job.booking) !== fingerprint(entry.desired) &&
          Date.parse(job.booking.startTime) !== Date.parse(entry.desired.originalStartTime)) continue;
      job.syncOwner = entry.key;
      if (!job.blockId && Number(job.attempts || 0) > 0 && ['queued', 'failed', 'superseded'].includes(job.status)) {
        entry.createIntent ||= { revision: fingerprint(job.booking), booking: copy(job.booking),
          legacyJobId: job.id, startedAt: job.updatedAt || stamp() };
        entry.status = 'review'; entry.errorCode = 'uncertain_legacy_create';
        entry.error = 'An attempted legacy job has no saved block ID; check its outcome before another write';
      }
      if (['queued', 'failed'].includes(job.status)) job.status = 'superseded';
      if (!job.blockId || !['succeeded', 'processing', 'replaced'].includes(job.status)) continue;
      if (entry.blocks.some(block => block.id === job.blockId)) continue;
      // Stored IDs are candidates for adoption, never permission for blind deletion.
      entry.blocks.push({ id: job.blockId, booking: copy(job.booking),
        expectedName: job.result?.name || `CatchCorner - ${job.booking.customer || 'Booking'}`,
        legacyJobId: job.id, origin: 'legacy', verifiedAt: null, removedAt: null });
    }
  }

  function migrateOccurrenceFamilies(current, events) {
    const families = new Map();
    for (const event of events.filter(item => item.originalStartTime)) {
      if (!families.has(event.eventId)) families.set(event.eventId, new Set());
      families.get(event.eventId).add(event.id);
    }
    for (const [uid, children] of families) {
      const parent = current.entries[`event:${uid}`];
      if (!parent || parent.retiredAt || parent.status === 'superseded') continue;
      const active = parent.blocks.filter(block => !block.removedAt);
      const assignments = active.map(block => {
        const candidates = [...children].map(key => current.entries[key]).filter(child =>
          fingerprint(child.desired) === fingerprint(block.booking) ||
          Date.parse(child.desired.originalStartTime) === Date.parse(block.booking.startTime));
        return { block, child: candidates.length === 1 ? candidates[0] : null };
      });
      if (parent.createIntent || assignments.some(item => !item.child)) {
        for (const key of children) {
          const child = current.entries[key];
          child.status = 'source_conflict'; child.errorCode = 'recurrence_migration_review';
          child.error = 'Existing series ownership is uncertain; retained blocks require verified migration';
        }
        continue;
      }
      for (const { block, child } of assignments) {
        if (!child.blocks.some(item => item.id === block.id)) child.blocks.push(block);
        const job = deps.getStore().jobs?.[block.legacyJobId];
        if (job?.syncOwner === parent.key) job.syncOwner = child.key;
      }
      parent.occurrenceMigration = { migratedAt: stamp(), children: [...children], blocks: copy(parent.blocks) };
      parent.blocks = [];
      parent.status = 'superseded'; parent.error = null; parent.errorCode = null; parent.pendingSince = null;
    }
  }

  async function acceptSnapshot(snapshot) {
    const calendars = snapshot?.calendars;
    if (snapshot?.schemaVersion !== 1 || snapshot.complete !== true || !Array.isArray(calendars) ||
        calendars.length !== deps.calendars.length || new Set(calendars).size !== calendars.length ||
        deps.calendars.some((id, index) => id !== calendars[index]) ||
        !Number.isFinite(Date.parse(snapshot.generatedAt)) || Date.parse(snapshot.generatedAt) > now() + 5 * MINUTE ||
        !Number.isFinite(Date.parse(snapshot.windowStart)) || !Number.isFinite(Date.parse(snapshot.windowEnd)) ||
        Date.parse(snapshot.windowStart) > now() || Date.parse(snapshot.windowEnd) <= now() ||
        !Array.isArray(snapshot.events) || snapshot.events.length > 5000 ||
        !Array.isArray(snapshot.reservations) || snapshot.reservations.length > 5000) {
      throw new Error('Incomplete or invalid calendar snapshot');
    }
    const events = snapshot.events.map(event => normalizeEvent(event, deps.calendars));
    const reservations = snapshot.reservations.map(event => normalizeEvent(event, deps.calendars));
    for (const event of [...events, ...reservations]) {
      if (Date.parse(event.startTime) >= Date.parse(snapshot.windowEnd) ||
          Date.parse(event.endTime) <= Date.parse(snapshot.windowStart)) throw new Error('Event outside snapshot window');
    }
    const current = state();
    if (accepting || administrativeAction) throw new Error('Another snapshot or recovery operation is being persisted; retry');
    if (current.snapshotAt && Date.parse(snapshot.generatedAt) <= Date.parse(current.snapshotAt)) {
      if (persistenceFault) {
        await deps.persist();
        persistenceFault = false;
      }
      return { accepted: false, stale: true, snapshotAt: current.snapshotAt };
    }
    const grouped = new Map();
    for (const event of events) {
      if (!grouped.has(event.id)) grouped.set(event.id, []);
      grouped.get(event.id).push(event);
    }
    const legacyAliases = new Map();
    for (const event of events) {
      if (!legacyAliases.has(event.legacyId)) legacyAliases.set(event.legacyId, new Set());
      legacyAliases.get(event.legacyId).add(event.eventId);
    }
    accepting = true;
    try {
      current.snapshotAt = iso(snapshot.generatedAt);
      current.windowStart = iso(snapshot.windowStart);
      current.windowEnd = iso(snapshot.windowEnd);
      current.reservations = reservations;
      for (const [key, group] of grouped) {
        const desired = group[0];
        let entry = current.entries[key];
        if (!entry) entry = current.entries[key] = { key, blocks: [], aliases: [], attempts: 0,
          firstSeenAt: stamp(), status: 'pending', pendingSince: stamp(), desired: copy(desired) };
        const changed = fingerprint(entry.desired) !== fingerprint(desired);
        entry.aliases = [...new Set([...entry.aliases, ...group.map(event => event.legacyId)])];
        entry.lastSeenAt = stamp();
        entry.missingSince = null;
        entry.missingCount = 0;
        if (entry.retiredAt) {
          entry.status = 'source_conflict'; entry.errorCode = 'retired_source_reappeared';
          entry.error = 'An explicitly retired source reappeared; manual review required'; continue;
        }
        const ambiguous = group.some(event => fingerprint(event) !== fingerprint(desired)) ||
          group.some(event => legacyAliases.get(event.legacyId).size > 1);
        if (ambiguous) {
          entry.status = 'source_conflict'; entry.error = 'Multiple source events disagree; no blocks changed';
          entry.errorCode = 'source_conflict'; continue;
        }
        entry.desired = copy(desired);
        migrate(entry);
        const conflictCleared = entry.status === 'conflict' && !reservations.some(reservation => overlaps(desired, reservation));
        // Keep a continuing conflict visible to the alert check that immediately
        // follows snapshot delivery; do not clear and rediscover it on every scan.
        if (changed || conflictCleared || ['source_conflict', 'missing', 'historical'].includes(entry.status)) {
          entry.status = 'pending'; entry.attempts = 0; entry.nextAttemptAt = stamp();
          entry.pendingSince = stamp(); entry.error = null; entry.errorCode = null;
        }
        if (Date.parse(desired.endTime) <= now()) {
          const drift = entry.blocks.some(block => !block.removedAt && fingerprint(block.booking) !== fingerprint(desired));
          entry.status = drift ? 'historical' : 'expired';
          entry.error = drift ? 'Past booking changed after its original block; audit only, no past write attempted' : null;
        }
      }
      migrateOccurrenceFamilies(current, events);
      for (const entry of Object.values(current.entries)) {
        if (entry.retiredAt || entry.status === 'superseded') continue;
        if (grouped.has(entry.key) || Date.parse(entry.desired.endTime) <= now()) continue;
        if (Date.parse(entry.desired.startTime) >= Date.parse(snapshot.windowEnd) ||
            Date.parse(entry.desired.endTime) <= Date.parse(snapshot.windowStart)) continue;
        entry.missingSince ||= stamp(); entry.missingCount = (entry.missingCount || 0) + 1;
        // Missing source events are reported, not converted into destructive cancellations.
        if (entry.missingCount >= 2 && now() - Date.parse(entry.missingSince) >= 10 * MINUTE) {
          entry.status = 'missing'; entry.errorCode = 'missing_source';
          entry.error = 'Source event missing from repeated complete scans; retained blocks need review';
        }
      }
      await deps.persist();
      persistenceFault = false;
      return { accepted: true, snapshotAt: current.snapshotAt, count: grouped.size };
    } catch (error) { persistenceFault = true; throw error; }
    finally { accepting = false; }
  }

  async function readOwned(block) {
    let result;
    try { result = await deps.readBlock(block.id); }
    catch (error) { if (missingBlock(error)) return null; throw error; }
    if (!matchingBlock(block.booking, result) || result.name !== block.expectedName) {
      const error = new Error(`Ownership/content mismatch for block ${block.id}; left untouched`);
      error.review = true; error.code = 'ownership_mismatch'; throw error;
    }
    return result;
  }

  function stillCurrent(entry, revision) {
    return !accepting && !persistenceFault && !administrativeAction && !entry.retiredAt &&
      !state().paused &&
      !entry.missingSince && fingerprint(entry.desired) === revision &&
      Date.parse(entry.desired.endTime) > now() && now() - Date.parse(state().snapshotAt) <= 20 * MINUTE &&
      !state().reservations.some(reservation => overlaps(entry.desired, reservation)) &&
      !['source_conflict', 'missing'].includes(entry.status);
  }

  function defer(entry) {
    if (entry.retiredAt || ['source_conflict', 'missing', 'review', 'historical', 'expired'].includes(entry.status)) return;
    entry.status = 'pending'; entry.nextAttemptAt = stamp();
  }

  async function advance(entry) {
    migrate(entry);
    if (entry.errorCode === 'uncertain_legacy_create') { await deps.persist(); return; }
    const desired = copy(entry.desired);
    const revision = fingerprint(desired);
    const conflict = state().reservations.find(reservation => overlaps(desired, reservation));
    if (conflict) {
      entry.status = 'conflict'; entry.errorCode = 'reservation_conflict';
      entry.error = `Existing Playtomic reservation: ${conflict.customer}; no customer booking changed`;
      entry.nextAttemptAt = new Date(now() + 5 * MINUTE).toISOString();
      await deps.persist(); return;
    }
    let target = entry.blocks.find(block => !block.removedAt && fingerprint(block.booking) === revision);
    if (target) {
      const present = await readOwned(target);
      if (!present) { target.removedAt = stamp(); target = null; await deps.persist(); }
      else target.verifiedAt = stamp();
    }
    if (!target) {
      if (entry.createIntent) {
        const error = new Error('A previous create may have reached Playtomic without a saved block ID; review before another write');
        error.review = true; error.code = 'uncertain_create'; throw error;
      }
      if (!stillCurrent(entry, revision)) return;
      const marker = crypto.createHash('sha256').update(entry.key + '|' + revision).digest('hex').slice(0, 20);
      const booking = { ...desired, customer: `${desired.customer.slice(0, 80)} [PJ-SYNC:${marker}]` };
      entry.createIntent = { revision, startedAt: stamp(), marker, booking };
      entry.status = 'creating';
      await deps.persist();
      if (!stillCurrent(entry, revision)) {
        entry.createIntent = null; defer(entry); await deps.persist(); return;
      }
      try {
        const result = await deps.createBlock(booking, async created => {
          const id = created.availability_block_id || created.availabilityBlockId || created.id ||
            created.availability_block?.id || created.data?.id;
          if (!id || typeof id !== 'string') throw new Error('Create checkpoint has no block ID');
          target = { id, booking, expectedName: `CatchCorner - ${booking.customer}`,
            origin: 'sync', createdAt: stamp(), verifiedAt: null, removedAt: null };
          entry.blocks.push(target);
          entry.createIntent = null;
          await deps.persist();
        });
        if (!target) throw new Error(`Create returned ${result?.id || 'no ID'} without durable checkpoint`);
      } catch (error) {
        if (!target && !error.safeToRetry) { error.review = true; error.code = 'uncertain_create'; }
        if (!target && error.safeToRetry) entry.createIntent = null;
        throw error;
      }
      const present = await readOwned(target);
      if (!present) throw new Error('New block disappeared before replacement verification');
      target.verifiedAt = stamp();
      await deps.persist();
    }
    if (!stillCurrent(entry, revision)) { defer(entry); await deps.persist(); return; }
    entry.status = 'cleanup';
    await deps.persist();
    for (const obsolete of entry.blocks.filter(block => !block.removedAt && block.id !== target.id)) {
      if (!stillCurrent(entry, revision)) { defer(entry); await deps.persist(); return; }
      // Verify the replacement again before every destructive step, including after restart.
      if (!await readOwned(target)) throw new Error('Replacement missing; obsolete block retained');
      const present = await readOwned(obsolete);
      if (present) {
        if (!stillCurrent(entry, revision)) { defer(entry); await deps.persist(); return; }
        try { await deps.removeBlock(obsolete.id); }
        catch (error) { if (!missingBlock(error)) throw error; }
        let after;
        try { after = await deps.readBlock(obsolete.id); }
        catch (error) { if (!missingBlock(error)) throw error; }
        if (after) throw new Error(`Obsolete block ${obsolete.id} still present after deletion`);
      }
      obsolete.removedAt = stamp();
      const legacy = deps.getStore().jobs?.[obsolete.legacyJobId];
      if (legacy?.blockId === obsolete.id) { legacy.status = 'replaced'; legacy.replacedBy = entry.key; }
      await deps.persist();
    }
    if (!stillCurrent(entry, revision)) { defer(entry); await deps.persist(); return; }
    entry.status = 'synced'; entry.syncedRevision = revision; entry.syncedAt = stamp();
    entry.error = null; entry.errorCode = null; entry.attempts = 0; entry.pendingSince = null;
    entry.nextAttemptAt = new Date(now() + 30 * MINUTE).toISOString();
    await deps.persist();
  }

  async function processNext() {
    if (running || accepting || persistenceFault || administrativeAction || state().paused || !state().snapshotAt) return false;
    // Never issue source-driven writes using an unattended stale calendar snapshot.
    if (now() - Date.parse(state().snapshotAt) > 20 * MINUTE) return false;
    const entry = Object.values(state().entries)
      .filter(item => !item.missingSince && Date.parse(item.desired.endTime) > now() &&
        ['pending', 'creating', 'cleanup', 'synced', 'conflict'].includes(item.status) &&
        (!item.nextAttemptAt || Date.parse(item.nextAttemptAt) <= now()))
      .sort((a, b) => (a.status === 'synced') - (b.status === 'synced') ||
        Date.parse(a.desired.startTime) - Date.parse(b.desired.startTime))[0];
    if (!entry) return false;
    running = true;
    const revision = fingerprint(entry.desired);
    try { await advance(entry); }
    catch (error) {
      if (['source_conflict', 'missing', 'retired', 'historical', 'expired'].includes(entry.status)) {
        // A concurrent authoritative scan already placed this source on hold.
      } else if (fingerprint(entry.desired) !== revision) {
        defer(entry);
      } else {
        entry.attempts += 1;
        entry.status = error.review || entry.attempts >= maxAttempts ? 'review' : 'pending';
        entry.errorCode = error.code || 'sync_failure';
        entry.error = String(error.message || error).slice(0, 1500);
        entry.pendingSince ||= stamp();
        entry.nextAttemptAt = new Date(now() + Math.min(30, 2 ** Math.min(entry.attempts - 1, 5)) * MINUTE).toISOString();
      }
      await deps.persist();
    } finally { running = false; }
    return true;
  }

  function summary() {
    const current = state();
    const entries = Object.values(current.entries);
    const issues = entries.filter(entry => entry.error && !['historical', 'expired'].includes(entry.status))
      .map(entry => ({ key: entry.key, status: entry.status, code: entry.errorCode,
        message: entry.error, booking: entry.desired, attempts: entry.attempts, nextAttemptAt: entry.nextAttemptAt }));
    if (current.paused) issues.push({ key: 'controller', code: 'paused', status: 'paused',
      message: 'Revision processing is paused by an operator; existing blocks are retained' });
    for (const entry of entries) {
      if (!entry.error && entry.pendingSince && now() - Date.parse(entry.pendingSince) > 10 * MINUTE &&
          Date.parse(entry.desired.endTime) > now()) issues.push({ key: entry.key, code: 'sync_overdue',
        status: entry.status, message: 'Current calendar revision has not completed within ten minutes', booking: entry.desired });
    }
    return { schemaVersion: 1, occurrenceIdentityVersion: 1, snapshotAt: current.snapshotAt, persistenceFault, paused: Boolean(current.paused),
      snapshotStale: Boolean(current.snapshotAt && now() - Date.parse(current.snapshotAt) > 20 * MINUTE),
      counts: Object.fromEntries([...new Set(entries.map(entry => entry.status))]
        .map(status => [status, entries.filter(entry => entry.status === status).length])),
      issues, historical: entries.filter(entry => entry.status === 'historical').map(copy),
      entries: entries.map(copy) };
  }

  async function recoverCreate(key, blockId) {
    if (running || accepting || administrativeAction) throw new Error('Worker is busy; retry recovery');
    const entry = state().entries[key];
    if (!entry?.createIntent?.booking || typeof blockId !== 'string' || !blockId) throw new Error('No recoverable create intent');
    administrativeAction = true;
    try {
      const intent = copy(entry.createIntent);
      const booking = copy(intent.booking);
      const candidate = { id: blockId, booking, expectedName: `CatchCorner - ${booking.customer}`,
        origin: 'recovered', createdAt: intent.startedAt, removedAt: null, legacyJobId: intent.legacyJobId };
      const persisted = await readOwned(candidate);
      if (!persisted) throw new Error('Recovery block is absent');
      if (!entry.blocks.some(block => block.id === blockId)) entry.blocks.push(candidate);
      const legacy = deps.getStore().jobs?.[intent.legacyJobId];
      if (legacy) { legacy.blockId = blockId; legacy.result = persisted; legacy.status = 'succeeded'; legacy.lastError = null; }
      entry.createIntent = null; entry.status = 'pending'; entry.error = null; entry.errorCode = null;
      entry.attempts = 0; entry.nextAttemptAt = stamp();
      await deps.persist();
      return { key, blockId, status: 'pending' };
    } finally { administrativeAction = false; }
  }

  async function retireSource(key) {
    if (running || accepting || administrativeAction) throw new Error('Worker is busy; retry retirement');
    const entry = state().entries[key];
    if (!entry || !entry.missingSince || entry.createIntent || !state().snapshotAt ||
        now() - Date.parse(state().snapshotAt) > 20 * MINUTE) {
      throw new Error('Retirement requires a fresh complete scan proving the source is absent and no uncertain create');
    }
    administrativeAction = true;
    try {
      // This is an explicit authenticated operator action, never automatic cancellation.
      for (const block of entry.blocks.filter(item => !item.removedAt)) {
        if (await readOwned(block)) {
          try { await deps.removeBlock(block.id); } catch (error) { if (!missingBlock(error)) throw error; }
          let remaining;
          try { remaining = await deps.readBlock(block.id); } catch (error) { if (!missingBlock(error)) throw error; }
          if (remaining) throw new Error('Retired block remains present: ' + block.id);
        }
        block.removedAt = stamp();
        await deps.persist();
      }
      entry.status = 'retired'; entry.retiredAt = stamp(); entry.error = null; entry.errorCode = null;
      await deps.persist();
      return { key, status: 'retired' };
    } finally { administrativeAction = false; }
  }

  async function previewSnapshot(snapshot) {
    const isolated = copy(deps.getStore());
    const preview = createBookingSync({ ...deps, getStore: () => isolated, persist: async () => {} });
    await preview.acceptSnapshot(snapshot);
    const report = preview.summary();
    const changes = report.entries.filter(entry => !['retired', 'expired'].includes(entry.status)).map(entry => {
      const existing = entry.blocks.filter(block => !block.removedAt);
      const targetExists = existing.some(block => fingerprint(block.booking) === fingerprint(entry.desired));
      const conflict = (snapshot.reservations || []).some(event => overlaps(entry.desired, event));
      const action = entry.status === 'historical' ? 'historical_drift' : entry.status === 'missing' ? 'missing_source' :
        ['source_conflict', 'review'].includes(entry.status) || entry.createIntent ? 'review' :
        conflict ? 'reservation_conflict' : targetExists ? 'verify_existing' : existing.length ? 'replace' : 'create';
      return { key: entry.key, action, booking: entry.desired, knownBlockIds: existing.map(block => block.id) };
    });
    return { schemaVersion: 1, occurrenceIdentityVersion: 1, dryRun: true, snapshotAt: report.snapshotAt,
      plannedCounts: Object.fromEntries([...new Set(changes.map(item => item.action))]
        .map(action => [action, changes.filter(item => item.action === action).length])), changes };
  }

  async function setPaused(paused) {
    if (typeof paused !== 'boolean') throw new Error('paused must be a boolean');
    state().paused = paused;
    await deps.persist();
    return { paused };
  }

  return { acceptSnapshot, previewSnapshot, processNext, summary, recoverCreate, retireSource, setPaused };
}

module.exports = { createBookingSync, fingerprint, matchingBlock, overlaps, normalizeEvent };
