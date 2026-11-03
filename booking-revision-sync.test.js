const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const crypto = require('node:crypto');

function script(responses = [], events = []) {
  const props = new Map();
  const emails = [];
  const calls = [];
  const context = {
    COURT1_CAL_ID: 'court-one', COURT2_CAL_ID: 'court-two', WEBHOOK_HORIZON_DAYS: 400,
    PLAYTOMIC_TAG: '(Playtomic)', BLOCKER_ALERT_EMAIL: 'owner@example.invalid',
    RAILWAY_WEBHOOK_URL: 'https://worker.example.invalid/webhook/catchcorner', WEBHOOK_SECRET: 'test-only',
    Logger: { log() {} }, ScriptApp: { getOAuthToken: () => 'test-only-oauth' },
    Utilities: { DigestAlgorithm: { SHA_256: 'SHA_256' }, Charset: { UTF_8: 'UTF_8' },
      computeDigest: (_algorithm, value) => [...crypto.createHash('sha256').update(value).digest()],
      parseDate: (value, zone) => new Date(value + (zone === 'UTC' ? 'T00:00:00Z' : 'T04:00:00Z')) },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => props.get(key) || null, setProperty: (key, value) => props.set(key, value), deleteProperty: key => props.delete(key),
    }) },
    GmailApp: { sendEmail: (...args) => emails.push(args) },
    CalendarApp: { getCalendarById: id => ({ getTimeZone: () => 'America/Toronto', getEvents: () => id === 'court-one' ? events : [] }) },
    UrlFetchApp: { fetch: (url, options) => {
      calls.push({ url, options });
      const response = responses.shift();
      if (!response) throw new Error('Unexpected request');
      return { getResponseCode: () => response.status, getContentText: () => JSON.stringify(response.body) };
    } },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('./booking-revision-sync.gs'), 'utf8'), context);
  return { context, props, emails, calls };
}

const calendarEvent = (start, end) => ({ getId: () => 'series@google.com', getTitle: () => 'Recurring lesson',
  isRecurringEvent: () => true, getStartTime: () => new Date(start), getEndTime: () => new Date(end) });

test('unchanged issue warnings do not repeat after six hours; new failures and recovery still email', () => {
  const issue = { key: 'old', code: 'source_conflict', status: 'source_conflict', booking: {} };
  const t = script([
    { status: 200, body: { schemaVersion: 1, issues: [issue] } },
    { status: 200, body: { schemaVersion: 1, issues: [issue] } },
    { status: 200, body: { schemaVersion: 1, issues: [issue, { ...issue, key: 'new' }] } },
    { status: 200, body: { schemaVersion: 1, issues: [] } },
  ]);
  t.context.checkCalendarSyncAlerts_();
  t.props.set('BOOKING_SYNC_ISSUE_ALERT_AT', new Date(Date.now() - 7 * 3600000).toISOString());
  t.context.checkCalendarSyncAlerts_(); assert.equal(t.emails.length, 1);
  t.context.checkCalendarSyncAlerts_(); assert.equal(t.emails.length, 2);
  t.context.checkCalendarSyncAlerts_(); assert.equal(t.emails.length, 3);
  assert.match(t.emails[2][1], /RECOVERED/);
});

test('Calendar API pagination supplies original occurrence identity after a session is moved', () => {
  const t = script([
    { status: 200, body: { items: [], nextPageToken: 'next' } },
    { status: 200, body: { items: [{ id: 'instance', iCalUID: 'series@google.com', recurringEventId: 'series',
      originalStartTime: { dateTime: '2027-09-15T14:00:00Z' },
      start: { dateTime: '2027-09-16T15:00:00Z' }, end: { dateTime: '2027-09-16T16:00:00Z' } }] } },
  ], [calendarEvent('2027-09-16T15:00:00Z', '2027-09-16T16:00:00Z')]);
  const snapshot = t.context.collectBookingCalendarSnapshot_(true);
  assert.equal(snapshot.events[0].occurrenceId, 'instance');
  assert.equal(snapshot.events[0].originalStartTime, '2027-09-15T14:00:00.000Z');
  assert.equal(snapshot.events[0].startTime, '2027-09-16T15:00:00.000Z');
  assert.match(t.calls[1].url, /pageToken=next/);
});

test('Calendar API permission or incomplete identity failures never become complete snapshots', () => {
  const event = calendarEvent('2027-09-16T15:00:00Z', '2027-09-16T16:00:00Z');
  const denied = script([{ status: 403, body: {} }], [event]);
  assert.throws(() => denied.context.collectBookingCalendarSnapshot_(true), /HTTP 403/);
  const absent = script([{ status: 200, body: { items: [] } }], [event]);
  assert.throws(() => absent.context.collectBookingCalendarSnapshot_(true), /Cannot uniquely identify/);
});

test('occurrence lookup is feature gated so deployment cannot interrupt the existing scan', () => {
  const t = script([], [calendarEvent('2027-09-16T15:00:00Z', '2027-09-16T16:00:00Z')]);
  const snapshot = t.context.collectBookingCalendarSnapshot_();
  assert.equal(t.calls.length, 0);
  assert.equal(snapshot.events[0].occurrenceId, undefined);
});

test('all-day occurrence dates retain calendar local boundaries and their original date identity', () => {
  const t = script([{ status: 200, body: { items: [{ id: 'all-day', iCalUID: 'series@google.com', recurringEventId: 'series',
    originalStartTime: { date: '2027-09-15' }, start: { date: '2027-09-16' }, end: { date: '2027-09-17' } }] } }],
  [calendarEvent('2027-09-16T04:00:00Z', '2027-09-17T04:00:00Z')]);
  const event = t.context.collectBookingCalendarSnapshot_(true).events[0];
  assert.equal(event.originalStartTime, '2027-09-15T00:00:00.000Z');
  assert.equal(event.startTime, '2027-09-16T04:00:00.000Z');
});

test('repeated API page tokens fail closed instead of looping or publishing partial recurrence data', () => {
  const t = script([
    { status: 200, body: { items: [], nextPageToken: 'same' } },
    { status: 200, body: { items: [], nextPageToken: 'same' } },
  ], [calendarEvent('2027-09-16T15:00:00Z', '2027-09-16T16:00:00Z')]);
  assert.throws(() => t.context.collectBookingCalendarSnapshot_(true), /pagination repeated/);
  assert.equal(t.calls.length, 2);
});
