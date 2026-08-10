const test = require('node:test');
const assert = require('node:assert/strict');

const {
  blockPayload,
  extractBlockId,
  jobIdFor,
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
