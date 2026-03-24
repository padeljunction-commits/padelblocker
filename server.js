/**
 * PADEL JUNCTION — PLAYTOMIC AUTO-BLOCKER
 * ----------------------------------------
 * Auth strategy:
 *   Cold start / token expired → Playwright browser login → capture Bearer token
 *   All bookings → direct API call (no browser)
 *
 * Browser is ONLY used to get a token. Never to fill forms.
 * Token lives in memory. On 401 or expiry → re-login via browser.
 *
 * Blocking endpoint + payload shape verified live March 2026:
 *   POST /api/v1/availability/availability_blocks
 *   { name, resource_ids[], start: UTC ISO, end: UTC ISO, tenant_id }
 */

require('dotenv').config();
const express      = require('express');
const { chromium } = require('playwright-core');

const app = express();
app.use(express.json());

const CONFIG = {
  PORT:                process.env.PORT || 3000,
  WEBHOOK_SECRET:      process.env.WEBHOOK_SECRET,
  PLAYTOMIC_EMAIL:     process.env.PLAYTOMIC_EMAIL,
  PLAYTOMIC_PASSWORD:  process.env.PLAYTOMIC_PASSWORD,
  PLAYTOMIC_TENANT_ID: process.env.PLAYTOMIC_TENANT_ID,
  CHROMIUM_PATH:       process.env.CHROMIUM_PATH || null,
};

const PLAYTOMIC_BASE = 'https://manager.playtomic.io';

const RESOURCE_IDS = {
  '1': '1f900b5d-f99d-4b17-9a8a-1ceb28be5299',
  '2': '6ea04658-e7db-456a-beef-efc9c91fa7b0',
};

let tokenState = {
  accessToken: null,
  expiresAt:   null,
};

let loginInProgress = null;

// ── BROWSER LOGIN ─────────────────────────────────────────────────────────────

async function captureTokenViaBrowser() {
  if (loginInProgress) {
    console.log('⏳ Browser login already in progress — waiting...');
    return loginInProgress;
  }
  loginInProgress = _doBrowserLogin().finally(() => { loginInProgress = null; });
  return loginInProgress;
}

async function _doBrowserLogin() {
  console.log('🌐 Starting browser login to capture token...');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    ...(CONFIG.CHROMIUM_PATH ? { executablePath: CONFIG.CHROMIUM_PATH } : {}),
  });

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page    = await context.newPage();
  let capturedToken = null;

  page.on('request', req => {
    if (capturedToken) return;
    const auth = req.headers()['authorization'] || '';
    if (req.url().includes('playtomic.io/api') && auth.startsWith('Bearer ')) {
      capturedToken = auth.replace('Bearer ', '');
      console.log('🔑 Token captured.');
    }
  });

  try {
    await page.goto(`${PLAYTOMIC_BASE}/auth/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByRole('textbox', { name: 'Email' }).waitFor({ timeout: 15000 });
    await page.getByRole('textbox', { name: 'Email' }).fill(CONFIG.PLAYTOMIC_EMAIL);
    await page.getByRole('textbox', { name: 'Password' }).fill(CONFIG.PLAYTOMIC_PASSWORD);
    await page.getByRole('button', { name: 'Log In' }).click();
    await page.waitForFunction(() => !window.location.pathname.includes('/auth/login'), { timeout: 30000 });
    console.log('✅ Logged in — waiting for token...');

    const start = Date.now();
    while (!capturedToken && Date.now() - start < 10000) {
      await page.waitForTimeout(200);
    }
    if (!capturedToken) throw new Error('Logged in but no token captured within 10s');

    tokenState = { accessToken: capturedToken, expiresAt: Date.now() + 55 * 60 * 1000 };
    console.log('✅ Token stored. Valid for ~55 min.');
    return capturedToken;

  } finally {
    await browser.close();
  }
}

// ── TOKEN ─────────────────────────────────────────────────────────────────────

async function getAccessToken() {
  if (tokenState.accessToken && Date.now() < tokenState.expiresAt) {
    return tokenState.accessToken;
  }
  console.log('🔄 Token missing/expired — browser login...');
  return captureTokenViaBrowser();
}

// ── CREATE BLOCK ──────────────────────────────────────────────────────────────

async function createBlock(booking) {
  const courtNum   = (booking.court.match(/\d+/) || ['1'])[0];
  const resourceId = RESOURCE_IDS[courtNum];
  if (!resourceId) throw new Error(`Unknown court: ${booking.court}`);

  const payload = {
    name:         `CatchCorner – ${booking.customer || 'Booking'}`,
    resource_ids: [resourceId],
    start:        booking.startTime,
    end:          booking.endTime,
    tenant_id:    CONFIG.PLAYTOMIC_TENANT_ID,
  };

  console.log(`📡 Block payload: ${JSON.stringify(payload)}`);

  const doRequest = async (token) => fetch(
    `${PLAYTOMIC_BASE}/api/v1/availability/availability_blocks`,
    {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body:    JSON.stringify(payload),
    }
  );

  const token = await getAccessToken();
  const res   = await doRequest(token);
  const text  = await res.text();
  console.log(`📡 Response ${res.status}: ${text.substring(0, 300)}`);

  if (res.status === 401) {
    console.log('🔄 401 — re-authenticating via browser...');
    tokenState.accessToken = null;
    const freshToken = await getAccessToken();
    const retry      = await doRequest(freshToken);
    const retryText  = await retry.text();
    console.log(`📡 Retry ${retry.status}: ${retryText.substring(0, 300)}`);
    if (!retry.ok) throw new Error(`API ${retry.status}: ${retryText}`);
    return JSON.parse(retryText);
  }

  if (!res.ok) throw new Error(`API ${res.status}: ${text}`);
  return JSON.parse(text);
}

// ── HEALTH ────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.json({
  status:   'ok',
  service:  'Padel Junction Playtomic Blocker',
  hasToken: !!tokenState.accessToken,
  tokenMinutesRemaining: tokenState.expiresAt ? Math.round((tokenState.expiresAt - Date.now()) / 60000) : null,
}));

// ── WEBHOOK ───────────────────────────────────────────────────────────────────

app.post('/webhook/catchcorner', async (req, res) => {
  const { secret, booking } = req.body;
  if (secret !== CONFIG.WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  if (!booking?.startTime || !booking?.endTime || !booking?.court)
    return res.status(400).json({ error: 'Missing booking fields' });

  console.log(`📥 Booking: ${booking.court} @ ${booking.startTime} – ${booking.endTime}`);
  res.json({ status: 'accepted' });

  try {
    const result = await createBlock(booking);
    console.log(`✅ Block created: ${result.availability_block_id}`);
  } catch (err) {
    console.error(`❌ Block failed for ${booking.id}: ${err.message}`);
  }
});

// ── STARTUP ───────────────────────────────────────────────────────────────────

app.listen(CONFIG.PORT, async () => {
  console.log(`🚀 Padel Junction Playtomic Blocker on port ${CONFIG.PORT}`);
  console.log(`   Email: ${CONFIG.PLAYTOMIC_EMAIL ? '✅' : '❌ MISSING'}`);
  console.log(`   Password: ${CONFIG.PLAYTOMIC_PASSWORD ? '✅' : '❌ MISSING'}`);
  try {
    await captureTokenViaBrowser();
    console.log('✅ Startup login complete — ready for bookings.');
  } catch (e) {
    console.error(`❌ Startup login failed: ${e.message}`);
    console.log('⚠️  Will retry on first booking.');
  }
});
