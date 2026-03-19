/**
 * PADEL JUNCTION — PLAYTOMIC AUTO-BLOCKER
 * ----------------------------------------
 * Uses Playwright's page.on('request') to capture the exact API call
 * that Playtomic Manager makes when creating a blocking, then replays
 * it directly for all future blockings — no UI interaction needed.
 *
 * First run: drives the UI to create a blocking while capturing the API call.
 * Subsequent runs: calls the API directly (fast, reliable, no UI fragility).
 */

require('dotenv').config();
const express = require('express');
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

// In-memory cache of the auth token — populated on first successful blocking
// Token is a Bearer token extracted from the captured API request
let cachedAuthToken = null;

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Padel Junction Playtomic Blocker', hasToken: !!cachedAuthToken });
});

// ── WEBHOOK ───────────────────────────────────────────────────────────────────
app.post('/webhook/catchcorner', async (req, res) => {
  const { secret, booking } = req.body;

  if (secret !== CONFIG.WEBHOOK_SECRET) {
    console.warn('⚠️  Unauthorized webhook rejected.');
    return res.status(403).json({ error: 'Unauthorized' });
  }

  if (!booking?.startTime || !booking?.endTime || !booking?.court) {
    return res.status(400).json({ error: 'Missing booking fields' });
  }

  console.log(`📥 Booking: ${booking.court} @ ${booking.startTime} – ${booking.endTime}`);
  res.json({ status: 'accepted' });

  try {
    if (cachedAuthToken) {
      // Fast path — call API directly
      await blockViaAPI(booking, cachedAuthToken);
    } else {
      // First run — drive UI, capture token, then use API
      await blockViaUIAndCaptureToken(booking);
    }
    console.log(`✅ Blocking created for ${booking.id}`);
  } catch (err) {
    console.error(`❌ Failed for ${booking.id}: ${err.message}`);
    // If API call failed with 401, token may have expired — clear it and retry via UI
    if (err.message?.includes('401') && cachedAuthToken) {
      console.log('🔄 Token may be expired, clearing and retrying via UI...');
      cachedAuthToken = null;
      try {
        await blockViaUIAndCaptureToken(booking);
        console.log(`✅ Blocking created on retry for ${booking.id}`);
      } catch (retryErr) {
        console.error(`❌ Retry also failed: ${retryErr.message}`);
      }
    }
  }
});

// ── DIRECT API CALL (fast path) ───────────────────────────────────────────────
async function blockViaAPI(booking, authToken) {
  const start = new Date(booking.startTime);
  const end   = new Date(booking.endTime);

  const courtNum   = booking.court.match(/\d+/)?.[0] || '1';
  const resourceId = courtNum === '1'
    ? '1f900b5d-f99d-4b17-9a8a-1ceb28be5299'
    : '6ea04658-e7db-456a-beef-efc9c91fa7b0';

  // Build the payload in the format Playtomic expects
  // Field names verified from captured API calls
  const payload = {
    tenant_id:   CONFIG.PLAYTOMIC_TENANT_ID,
    resource_id: resourceId,
    start_date:  toLocalDateStr(start),
    start_time:  toLocalTimeStr(start),
    end_time:    toLocalTimeStr(end),
    title:       `CatchCorner – ${booking.customer}`,
  };

  console.log(`📡 Calling API directly: ${JSON.stringify(payload)}`);

  const response = await fetch('https://manager.playtomic.io/api/v1/availability_blocks', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${authToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  console.log(`📡 API response ${response.status}: ${text.substring(0, 200)}`);

  if (!response.ok) {
    throw new Error(`API returned ${response.status}: ${text}`);
  }

  return JSON.parse(text);
}

// ── UI-DRIVEN PATH (captures auth token on first run) ─────────────────────────
async function blockViaUIAndCaptureToken(booking) {
  const launchOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  };
  if (CONFIG.CHROMIUM_PATH) launchOptions.executablePath = CONFIG.CHROMIUM_PATH;

  const browser = await chromium.launch(launchOptions);
  const context  = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page     = await context.newPage();

  // ── CAPTURE API CALLS via Playwright's request event ─────────────────────
  let capturedToken = null;
  let capturedPayload = null;
  let capturedURL = null;

  page.on('request', request => {
    const url = request.url();
    const method = request.method();
    if (url.includes('playtomic.io/api') && (method === 'POST' || method === 'PATCH' || method === 'PUT')) {
      const headers = request.headers();
      const auth = headers['authorization'] || headers['Authorization'];
      if (auth && auth.startsWith('Bearer ')) {
        capturedToken = auth.replace('Bearer ', '');
        capturedURL = url;
        try { capturedPayload = request.postData(); } catch(_) {}
        console.log(`🔑 Captured API call: ${method} ${url}`);
        console.log(`🔑 Auth token: ${capturedToken.substring(0, 20)}...`);
        console.log(`🔑 Payload: ${capturedPayload}`);
      }
    }
  });

  try {
    // ── LOGIN ─────────────────────────────────────────────────────────────
    console.log('🔐 Logging in...');
    await page.goto('https://manager.playtomic.io/auth/login', {
      waitUntil: 'domcontentloaded', timeout: 60000,
    });
    await page.getByRole('textbox', { name: 'Email' }).waitFor({ timeout: 15000 });
    await page.getByRole('textbox', { name: 'Email' }).fill(CONFIG.PLAYTOMIC_EMAIL);
    await page.getByRole('textbox', { name: 'Password' }).fill(CONFIG.PLAYTOMIC_PASSWORD);
    await page.getByRole('button', { name: 'Log In' }).click();
    await page.waitForFunction(
      () => !window.location.pathname.includes('/auth/login'),
      { timeout: 30000 }
    );
    await page.waitForTimeout(1500);
    console.log('✅ Logged in.');

    // ── OPEN FORM ─────────────────────────────────────────────────────────
    const blockUrl = `https://manager.playtomic.io/dashboard/schedule/add/block?tid=${CONFIG.PLAYTOMIC_TENANT_ID}`;
    await page.goto(blockUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByPlaceholder('E.g.: Maintenance').waitFor({ timeout: 15000 });
    await page.waitForTimeout(500);
    console.log('📝 Form loaded.');

    // ── FILL TITLE ────────────────────────────────────────────────────────
    await page.getByPlaceholder('E.g.: Maintenance').fill(`CatchCorner – ${booking.customer}`);

    // ── SELECT COURT ──────────────────────────────────────────────────────
    const courtNum  = booking.court.match(/\d+/)?.[0] || '1';
    const courtName = `Padel ${courtNum}`;

    // Click to focus, space to open (verified reliable approach)
    await page.mouse.click(748, 205);
    await page.waitForTimeout(200);
    await page.keyboard.press('Space');
    await page.waitForTimeout(400);
    await page.evaluate((name) => {
      const opt = Array.from(document.querySelectorAll('.select__option'))
        .find(o => o.textContent.trim() === name);
      if (!opt) throw new Error(`Court "${name}" not found`);
      opt.click();
    }, courtName);
    await page.waitForTimeout(400);
    console.log(`🏓 Court: ${courtName}`);

    // ── SET START TIME ────────────────────────────────────────────────────
    const start     = new Date(booking.startTime);
    const end       = new Date(booking.endTime);
    const startDisp = toDisplayTime(start);
    const endDisp   = toDisplayTime(end);
    const startType = toTypeStr(start);
    const endType   = toTypeStr(end);

    await page.mouse.click(573, 302);
    await page.waitForTimeout(200);
    await page.keyboard.press('Space');
    await page.waitForTimeout(300);
    await page.keyboard.type(startType);
    await page.waitForTimeout(300);
    await page.evaluate((disp) => {
      const opt = Array.from(document.querySelectorAll('.select__option'))
        .filter(o => o.offsetParent)
        .find(o => o.textContent.trim() === disp);
      if (!opt) throw new Error(`Start time "${disp}" not found`);
      opt.click();
    }, startDisp);
    await page.waitForTimeout(300);
    console.log(`⏰ Start: ${startDisp}`);

    // ── SET END TIME ──────────────────────────────────────────────────────
    await page.mouse.click(805, 302);
    await page.waitForTimeout(200);
    await page.keyboard.press('Space');
    await page.waitForTimeout(300);
    await page.keyboard.type(endType);
    await page.waitForTimeout(300);
    await page.evaluate((disp) => {
      const opt = Array.from(document.querySelectorAll('.select__option'))
        .filter(o => o.offsetParent)
        .find(o => o.textContent.trim() === disp);
      if (!opt) throw new Error(`End time "${disp}" not found`);
      opt.click();
    }, endDisp);
    await page.waitForTimeout(300);
    console.log(`⏰ End: ${endDisp}`);

    // ── SUBMIT ────────────────────────────────────────────────────────────
    await takeScreenshot(page, booking.id, 'before-submit');
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForTimeout(3000);
    await takeScreenshot(page, booking.id, 'after-submit');

    const urlOk = !page.url().includes('/add/block');
    if (urlOk) {
      console.log('✅ Blocking created via UI.');
    } else {
      throw new Error('Still on form after submit — blocking may have failed');
    }

    // ── CACHE THE TOKEN ───────────────────────────────────────────────────
    if (capturedToken) {
      cachedAuthToken = capturedToken;
      console.log(`🔑 Auth token cached for future API calls.`);
      console.log(`🔑 API URL was: ${capturedURL}`);
      console.log(`🔑 API Payload was: ${capturedPayload}`);
    } else {
      console.warn('⚠️  No API call captured — future requests will continue using UI');
    }

  } catch (err) {
    await takeScreenshot(page, booking.id, 'error');
    throw err;
  } finally {
    await browser.close();
  }
}

// ── TIME HELPERS ──────────────────────────────────────────────────────────────

function toLocalDateStr(date) {
  // "2026-03-19" in UTC (bookings sent as UTC ISO strings)
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function toLocalTimeStr(date) {
  // "14:00" in UTC
  const h = String(date.getUTCHours()).padStart(2, '0');
  const m = String(date.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function toTypeStr(date) {
  // "4:00" — typed to filter dropdown
  let h = date.getUTCHours();
  const m = date.getUTCMinutes();
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')}`;
}

function toDisplayTime(date) {
  // "04:00 p.m." — exact dropdown option text
  let h = date.getUTCHours();
  const m   = date.getUTCMinutes();
  const mer = h >= 12 ? 'p.m.' : 'a.m.';
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ${mer}`;
}

// ── SCREENSHOT ────────────────────────────────────────────────────────────────
async function takeScreenshot(page, bookingId, label) {
  try {
    const buffer = await page.screenshot({ fullPage: false });
    console.log(`📸 [${bookingId}-${label}] data:image/png;base64,${buffer.toString('base64')}`);
  } catch (_) {}
}

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(CONFIG.PORT, () => {
  console.log(`🚀 Padel Junction Playtomic Blocker on port ${CONFIG.PORT}`);
});
