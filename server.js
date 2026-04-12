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

const BROWSER_HEADERS = {
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Origin':          PLAYTOMIC_BASE,
  'Referer':         `${PLAYTOMIC_BASE}/`,
  'User-Agent':      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'X-Requested-With':'XMLHttpRequest',
};

let tokenState = { accessToken: null, expiresAt: null };
let loginInProgress = null;

function decodeJwtPayload(token) {
  try {
    const part = token.split('.')[1];
    const b64  = part.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch (e) {
    return null;
  }
}

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

  // Collect ALL bearer tokens we see during login. Playtomic issues several
  // and only the post-dashboard one carries ROLE_TENANT_MANAGER.
  const candidateTokens = new Set();
  page.on('request', req => {
    const auth = req.headers()['authorization'] || '';
    if (req.url().includes('playtomic.io/api') && auth.startsWith('Bearer ')) {
      candidateTokens.add(auth.replace('Bearer ', ''));
    }
  });

  try {
    await page.goto(`${PLAYTOMIC_BASE}/auth/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByRole('textbox', { name: 'Email' }).waitFor({ timeout: 15000 });
    await page.getByRole('textbox', { name: 'Email' }).fill(CONFIG.PLAYTOMIC_EMAIL);
    await page.getByRole('textbox', { name: 'Password' }).fill(CONFIG.PLAYTOMIC_PASSWORD);
    await page.getByRole('button', { name: 'Log In' }).click();
    await page.waitForFunction(() => !window.location.pathname.includes('/auth/login'), { timeout: 30000 });
    console.log('✅ Logged in.');

    // Navigate to the dashboard to force the manager-scoped token to be emitted
    console.log('📊 Loading dashboard to trigger manager-scoped token...');
    await page.goto(
      `${PLAYTOMIC_BASE}/dashboard/schedule?tid=${CONFIG.PLAYTOMIC_TENANT_ID}`,
      { waitUntil: 'networkidle', timeout: 30000 }
    ).catch(() => {}); // networkidle can flake — we just need it to load enough
    // Give late XHRs a moment to fire
    await page.waitForTimeout(2000);

    console.log(`🔑 Captured ${candidateTokens.size} candidate token(s). Selecting manager-scoped one...`);

    let bestToken = null;
    let bestExp   = null;
    for (const tok of candidateTokens) {
      const payload = decodeJwtPayload(tok);
      if (!payload) continue;
      const scopes = payload.scopes || [];
      const hasManager = scopes.includes('ROLE_TENANT_MANAGER');
      console.log(`  - sub=${payload.sub} scopes=[${scopes.join(',')}] manager=${hasManager}`);
      if (hasManager) {
        bestToken = tok;
        bestExp   = payload.exp ? payload.exp * 1000 : null;
      }
    }

    if (!bestToken) {
      throw new Error(`No token with ROLE_TENANT_MANAGER found among ${candidateTokens.size} candidates`);
    }

    const expiresAt = bestExp
      ? bestExp - 60_000  // 1 min safety buffer before real expiry
      : Date.now() + 55 * 60 * 1000;
    tokenState = { accessToken: bestToken, expiresAt };
    const minsLeft = Math.round((expiresAt - Date.now()) / 60000);
    console.log(`✅ Manager-scoped token stored. Valid for ~${minsLeft} min.`);
    return bestToken;
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
      console.log('📡 Sending POST to Playtomic...');
      const r = await fetch(`${PLAYTOMIC_BASE}/api/v1/availability/availability_blocks`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type':  'application/json',
          ...BROWSER_HEADERS,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      console.log(`📡 Headers received. Status: ${r.status}`);
      const bodyText = await Promise.race([
        r.text(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('body read timeout after 10s')), 10000)),
      ]);
      clearTimeout(t);
      return { status: r.status, ok: r.ok, text: bodyText, headers: r.headers };
    } catch (e) {
      clearTimeout(t);
      console.log(`❌ doRequest threw: ${e.name} - ${e.message}`);
      throw e;
    }
  };

  const token = await getAccessToken();
  const res   = await doRequest(token);
  console.log(`📡 Response ${res.status}: ${res.text.substring(0, 500)}`);

  if (res.status === 401 || res.status === 403) {
    console.log(`🔄 ${res.status} — re-authenticating...`);
    tokenState.accessToken = null;
    const fresh = await getAccessToken();
    const retry = await doRequest(fresh);
    console.log(`📡 Retry ${retry.status}: ${retry.text.substring(0, 500)}`);
    if (!retry.ok) throw new Error(`API ${retry.status}: ${retry.text}`);
    return JSON.parse(retry.text);
  }
  if (!res.ok) throw new Error(`API ${res.status}: ${res.text}`);
  return JSON.parse(res.text);
}

// ── PING (GET) — tests basic outbound connectivity ────────────────────────────
app.get('/ping', async (req, res) => {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(`${PLAYTOMIC_BASE}/api/v1/tenants/47a6875c-4bef-461b-bb7c-8fb21dbffbf0`, {
      headers: BROWSER_HEADERS,
      signal: controller.signal,
    });
    clearTimeout(t);
    res.json({ reachable: true, status: r.status });
  } catch (e) {
    clearTimeout(t);
    res.json({ reachable: false, error: e.name, message: e.message });
  }
});

// ── PING (POST) — tests whether Railway → Playtomic POSTs work at all ─────────
app.get('/ping-post', async (req, res) => {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 10000);
  try {
    const r = await fetch(`${PLAYTOMIC_BASE}/api/v1/availability/availability_blocks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...BROWSER_HEADERS,
      },
      body: '{}',
      signal: controller.signal,
    });
    const text = await Promise.race([
      r.text(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('body read timeout')), 8000)),
    ]);
    clearTimeout(t);
    res.json({
      reachable: true,
      status:    r.status,
      body:      text.substring(0, 300),
      headers:   Object.fromEntries(r.headers),
    });
  } catch (e) {
    clearTimeout(t);
    res.json({ reachable: false, error: e.name, message: e.message });
  }
});

// ── TOKEN INSPECT — see what scopes the current token has ────────────────────
app.get('/token-info', async (req, res) => {
  if (!tokenState.accessToken) return res.json({ hasToken: false });
  const payload = decodeJwtPayload(tokenState.accessToken);
  res.json({
    hasToken: true,
    minutesRemaining: Math.round((tokenState.expiresAt - Date.now()) / 60000),
    sub: payload?.sub,
    scopes: payload?.scopes,
    username: payload?.username,
    exp: payload?.exp ? new Date(payload.exp * 1000).toISOString() : null,
  });
});

app.get('/', (req, res) => res.json({
  status: 'ok',
  service: 'Padel Junction Playtomic Blocker',
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
