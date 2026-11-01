const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('snapshot HTTP interface authenticates, validates completeness and persists before acknowledging', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'padel-sync-http-'));
  process.env.WEBHOOK_SECRET = 'local-test-secret';
  process.env.BOOKING_CALENDAR_IDS = 'court1, court2';
  process.env.JOB_STORE_PATH = path.join(directory, 'jobs.json');
  const { app } = require('./server');
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, body, authorized = true) => fetch(base + url, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(authorized ? { 'x-webhook-secret': 'local-test-secret' } : {}) },
    body: JSON.stringify(body) });
  const calendars = ['court1', 'court2'];
  const now = Date.now();
  const snapshot = { schemaVersion: 1, complete: true, generatedAt: new Date(now).toISOString(),
    windowStart: new Date(now - 86400000).toISOString(), windowEnd: new Date(now + 400 * 86400000).toISOString(),
    calendars, events: [], reservations: [] };
  try {
    assert.equal((await request('/sync/calendar', snapshot, false)).status, 403);
    assert.equal((await request('/sync/calendar', { ...snapshot, complete: false })).status, 400);
    assert.equal(fs.existsSync(process.env.JOB_STORE_PATH), false);
    const accepted = await request('/sync/calendar', snapshot);
    assert.equal(accepted.status, 202);
    assert.equal((await accepted.json()).accepted, true);
    assert.equal(JSON.parse(fs.readFileSync(process.env.JOB_STORE_PATH, 'utf8')).bookingSync.snapshotAt, snapshot.generatedAt);
    const reportResponse = await fetch(base + '/admin/sync', { headers: { 'x-webhook-secret': 'local-test-secret' } });
    assert.equal(reportResponse.status, 200);
    assert.equal((await reportResponse.json()).snapshotAt, snapshot.generatedAt);
    const health = await (await fetch(base)).json();
    assert.equal(health.revisionSync.protocolVersion, 1);
    assert.equal(health.jobs.queued, 0);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
