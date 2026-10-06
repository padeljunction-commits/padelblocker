const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

const {
  blockPayload,
  blockMatchesBooking,
  calendarWatcherHealth,
  extractBlockId,
  jobIdFor,
  submitBlockAndWait,
  toDateStr,
  toDisplayTime,
  toTypeStr,
  validateBooking,
} = require('./server');

const base = {
  id: 'calendar-event-1',
  court: 'Padel 1',
  customer: 'Test',
  startTime: '2026-09-15T21:15:00.000Z',
  endTime: '2026-09-15T22:45:00.000Z',
};

test('validates a complete booking', () => {
  assert.equal(validateBooking(base), null);
  assert.match(validateBooking({ ...base, court: 'Padel 9' }), /Unknown court/);
  assert.match(validateBooking({ ...base, endTime: base.startTime }), /Invalid booking time range/);
});

test('a failed submit followed by page close cannot crash the worker', () => {
  const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '-e', `
    const { submitBlockAndWait } = require('./server');
    let rejectResponse;
    const page = {waitForResponse: () => new Promise((_, reject) => {rejectResponse = reject})};
    (async () => {
      try {
        await submitBlockAndWait(page, async () => {throw new Error('Create button not found')});
        process.exitCode = 2;
      } catch (error) {
        if (error.message !== 'Create button not found') process.exitCode = 3;
      } finally {
        rejectResponse(new Error('Target page, context or browser has been closed'));
      }
      await new Promise(resolve => setImmediate(resolve));
    })();
  `], { cwd: __dirname, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('response failure during submission remains a handled job error', async () => {
  let rejectResponse;
  const page = { waitForResponse: () => new Promise((_, reject) => { rejectResponse = reject; }) };
  await assert.rejects(submitBlockAndWait(page, async () => {
    rejectResponse(new Error('response timeout'));
    await new Promise(resolve => setImmediate(resolve));
  }), /response timeout/);
});

test('successful submit returns its observed response', async () => {
  const response = { id: 'persisted-response' };
  let submitted = false;
  assert.equal(await submitBlockAndWait({ waitForResponse: async () => response }, async () => {
    submitted = true;
  }), response);
  assert.equal(submitted, true);
});

test('idempotency key is stable and changes with booking revision', () => {
  assert.equal(jobIdFor(base), jobIdFor({ ...base }));
  assert.notEqual(jobIdFor(base), jobIdFor({ ...base, startTime: '2026-09-15T21:30:00.000Z' }));
});

test('API payload preserves UTC and court resource', () => {
  const payload = blockPayload(base);
  assert.equal(payload.start, '2026-09-15T21:15:00Z');
  assert.equal(payload.end, '2026-09-15T22:45:00Z');
  assert.deepEqual(payload.resource_ids, ['1f900b5d-f99d-4b17-9a8a-1ceb28be5299']);
});

test('Toronto UI date and several time forms are correct in September', () => {
  const start = new Date('2026-09-15T21:15:00.000Z');
  const noon = new Date('2026-09-15T16:00:00.000Z');
  const late = new Date('2026-09-16T03:30:00.000Z');
  assert.equal(toDateStr(start), '2026-09-15');
  assert.equal(toTypeStr(start), '5:15');
  assert.equal(toDisplayTime(start), '05:15 p.m.');
  assert.equal(toDisplayTime(noon), '12:00 p.m.');
  assert.equal(toDisplayTime(late), '11:30 p.m.');
});

test('extracts block ids from known response shapes', () => {
  assert.equal(extractBlockId({ availability_block_id: 'a' }), 'a');
  assert.equal(extractBlockId({ id: 'b' }), 'b');
  assert.equal(extractBlockId({ availability_block: { id: 'c' } }), 'c');
});

test('calendar watcher health distinguishes missing, fresh, and stale heartbeats', () => {
  const now = Date.parse('2026-08-28T18:00:00.000Z');
  assert.equal(calendarWatcherHealth(now, {}).status, 'missing');
  assert.equal(calendarWatcherHealth(now, {
    lastCalendarHeartbeatAt: '2026-08-28T17:45:00.000Z',
    scannedEvents: 42,
    pendingEvents: 1,
  }).status, 'ok');
  const stale = calendarWatcherHealth(now, {
    lastCalendarHeartbeatAt: '2026-08-28T17:30:00.000Z',
  });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.ageMinutes, 30);
});

test('post-write verification rejects a previous-month Playtomic block', () => {
  const expected = blockPayload(base);
  assert.equal(blockMatchesBooking(base, expected), true);
  assert.equal(blockMatchesBooking(base, {
    ...expected,
    start: '2026-08-15T21:15:00',
    end: '2026-08-15T22:45:00',
  }), false);
});
