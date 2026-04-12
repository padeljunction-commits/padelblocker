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

let tokenState = { accessToken: null, expiresAt: null };
let loginInProgress = null;

async function captureTokenViaBrowser() {
  if (loginInProgress) return loginInProgress;
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

async function getAccessToken() {
  if (tokenState.accessToken && Date.now() < tokenState.expiresAt) return tokenState.accessToken;
  console.log('🔄 Token missing/expired — browser login...');
  return captureTokenViaBrowser();
}

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

  const doRequest = async (token) => {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 15000);
    try {
      const r = await fetch(`${PLAYTOMIC_BASE}/api/v1/availability/availability_blocks`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(t);
      return r;
    } catch(e) {
      clearTimeout(t);
      throw e;
    }
  };

  const token = await getAccessToken();
  const res   = await doRequest(token);
  const text  = await res.text();
  console.log(`📡 Response ${res.status}: ${text.substring(0, 300)}`);
  if (res.status === 401) {
    console.log('🔄 401 — re-authenticating...');
    tokenState.accessToken = null;
    const fresh = await getAccessToken();
    const retry = await doRequest(fresh);
    const rt    = await retry.text();
    console.log(`📡 Retry ${retry.status}: ${rt.substring(0, 300)}`);
    if (!retry.ok) throw new Error(`API ${retry.status}: ${rt}`);
    return JSON.parse(rt);
  }
  if (!res.ok) throw new Error(`API ${res.status}: ${text}`);
  return JSON.parse(text);
}

// ── PING — tests outbound connectivity from Railway ───────────────────────────
app.get('/ping', async (req, res) => {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch('https://manager.playtomic.io/api/v1/tenants/47a6875c-4bef-461b-bb7c-8fb21dbffbf0', { signal: controller.signal });
    clearTimeout(t);
    res.json({ reachable: true, status: r.status });
  } catch(e) {
    clearTimeout(t);
    res.json({ reachable: false, error: e.name, message: e.message });
  }
});

app.get('/', (req, res) => res.json({
  status: 'ok', service: 'Padel Junction Playtomic Blocker',
  hasToken: !!tokenState.accessToken,
  tokenMinutesRemaining: tokenState.expiresAt ? Math.round((tokenState.expiresAt - Date.now()) / 60000) : null,
}));

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

app.listen(CONFIG.PORT, async () => {
  console.log(`🚀 Padel Junction Playtomic Blocker on port ${CONFIG.PORT}`);
  try {
    await captureTokenViaBrowser();
    console.log('✅ Startup login complete — ready for bookings.');
  } catch (e) {
    console.error(`❌ Startup login failed: ${e.message}`);
  }
});
