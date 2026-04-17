/**
 * PADEL JUNCTION — PLAYTOMIC AUTO-BLOCKER
 * ----------------------------------------
 * Selectors fully verified in live browser (April 2026):
 *
 *   openDropdown(id)      → input.focus() + Space keydown on #input-{resource|startTime|endTime}
 *   filterDropdown(id,t)  → nativeSetter + input event
 *   pickOption(exact)     → click .select__option by exact text
 *
 * On first blocking: drives browser UI, captures auth token from localStorage
 * On subsequent blockings: calls Playtomic API directly (no browser needed)
 *
 * FIX (Apr 2026): Playtomic wrapped the blocking form in a Modal component that
 * adds a permanent backdrop (position:fixed; inset:0; pointer-events:auto).
 * Playwright headless incorrectly flags this backdrop as intercepting all
 * .click() actions inside the form. Fix: replace every page.click() inside
 * the form with page.evaluate(() => element.click()), which calls the DOM
 * method directly and bypasses Playwright's actionability/hit-test check.
 * Verified working: 3/3 test blocks created successfully on Apr 17 2026.
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

// Cached Bearer token — populated from localStorage on first UI run
let cachedAuthToken = null;

// ── HEALTH ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) =>
  res.json({ status: 'ok', service: 'Padel Junction Playtomic Blocker', hasToken: !!cachedAuthToken })
);

// ── WEBHOOK ───────────────────────────────────────────────────────────────────
app.post('/webhook/catchcorner', async (req, res) => {
  const { secret, booking } = req.body;
  if (secret !== CONFIG.WEBHOOK_SECRET)
    return res.status(403).json({ error: 'Unauthorized' });
  if (!booking?.startTime || !booking?.endTime || !booking?.court)
    return res.status(400).json({ error: 'Missing booking fields' });

  console.log(`📥 Booking: ${booking.court} @ ${booking.startTime} – ${booking.endTime}`);
  res.json({ status: 'accepted' });

  try {
    if (cachedAuthToken) {
      await blockViaAPI(booking);
    } else {
      await blockViaBrowser(booking);
    }
    console.log(`✅ Blocking created for ${booking.id}`);
  } catch (err) {
    console.error(`❌ Failed for ${booking.id}: ${err.message}`);
    // If token expired, clear and retry via browser
    if (err.message?.includes('401') && cachedAuthToken) {
      console.log('🔄 Token expired — retrying via browser...');
      cachedAuthToken = null;
      try {
        await blockViaBrowser(booking);
        console.log(`✅ Retry succeeded for ${booking.id}`);
      } catch (e2) {
        console.error(`❌ Retry failed: ${e2.message}`);
      }
    }
  }
});

// ── FAST PATH: direct API call ────────────────────────────────────────────────
async function blockViaAPI(booking) {
  const start      = new Date(booking.startTime);
  const end        = new Date(booking.endTime);
  const courtNum   = booking.court.match(/\d+/)?.[0] || '1';
  const resourceId = courtNum === '1'
    ? '1f900b5d-f99d-4b17-9a8a-1ceb28be5299'
    : '6ea04658-e7db-456a-beef-efc9c91fa7b0';

  // Playtomic expects local datetime strings WITHOUT timezone offset
  // Format: "2026-04-05T21:00:00" (no Z, no milliseconds) — verified from working API response
  const payload = {
    tenant_id:    CONFIG.PLAYTOMIC_TENANT_ID,
    resource_ids: [resourceId],
    name:         `CatchCorner – ${booking.customer || 'Booking'}`,
    start:        toLocalISOString(start),
    end:          toLocalISOString(end),
  };

  console.log(`📡 Block payload: ${JSON.stringify(payload)}`);
  const res = await fetch('https://manager.playtomic.io/api/v1/availability/availability_blocks', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cachedAuthToken}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  console.log(`📡 API response ${res.status}: ${text.substring(0, 300)}`);
  if (!res.ok) throw new Error(`API ${res.status}: ${text}`);
  return JSON.parse(text);
}

// ── BROWSER PATH ──────────────────────────────────────────────────────────────
async function blockViaBrowser(booking) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    ...(CONFIG.CHROMIUM_PATH ? { executablePath: CONFIG.CHROMIUM_PATH } : {}),
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page    = await context.newPage();

  try {
    // LOGIN
    console.log('🔐 Logging in...');
    await page.goto('https://manager.playtomic.io/auth/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByRole('textbox', { name: 'Email' }).waitFor({ timeout: 15000 });
    await page.getByRole('textbox', { name: 'Email' }).fill(CONFIG.PLAYTOMIC_EMAIL);
    await page.getByRole('textbox', { name: 'Password' }).fill(CONFIG.PLAYTOMIC_PASSWORD);
    await page.getByRole('button', { name: 'Log In' }).click();
    await page.waitForFunction(() => !window.location.pathname.includes('/auth/login'), { timeout: 30000 });
    await page.waitForTimeout(2000);
    console.log('✅ Logged in.');

    // Read the ROLE_TENANT_MANAGER token directly from localStorage.
    // Playtomic stores it at: accessTokens.tenant[TENANT_ID].value
    // This is distinct from accessTokens.customer which only has ROLE_CUSTOMER scope.
    const token = await page.evaluate((tenantId) => {
      const auth = JSON.parse(localStorage.getItem('playtomic:auth') || '{}');
      return auth?.accessTokens?.tenant?.[tenantId]?.value || null;
    }, CONFIG.PLAYTOMIC_TENANT_ID);

    if (token) {
      cachedAuthToken = token;
      console.log('🔑 ROLE_TENANT_MANAGER token read from localStorage.');
    } else {
      throw new Error('Tenant token not found in localStorage after login — cannot proceed.');
    }

    const start     = new Date(booking.startTime);
    const end       = new Date(booking.endTime);
    const courtNum  = booking.court.match(/\d+/)?.[0] || '1';
    const courtName = `Padel ${courtNum}`;
    const startDisp = toDisplayTime(start);
    const endDisp   = toDisplayTime(end);
    const startType = toTypeStr(start);
    const endType   = toTypeStr(end);
    const dateStr   = toDateStr(start);

    // OPEN FORM — pass date in URL to pre-fill the date field
    await page.goto(
      `https://manager.playtomic.io/dashboard/schedule/add/block?tid=${CONFIG.PLAYTOMIC_TENANT_ID}&date=${dateStr}`,
      { waitUntil: 'domcontentloaded', timeout: 60000 }
    );
    await page.locator('#input-resource').waitFor({ timeout: 15000 });
    await page.waitForTimeout(500);
    console.log('📝 Form loaded.');

    // TITLE — use nativeSetter via evaluate (avoids any page.click() inside the modal)
    await page.evaluate((title) => {
      const inp = document.getElementById('input-name');
      if (!inp) throw new Error('#input-name not found');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, title);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }, `CatchCorner – ${booking.customer || 'Booking'}`);

    // DATE — URL param pre-fills it; if not, set via evaluate (no page.click() needed)
    const dateActual = await page.locator('#input-startDate').inputValue();
    if (dateActual !== dateStr) {
      console.log(`📆 URL param did not pre-fill date ("${dateActual}") — setting via evaluate`);
      await page.evaluate((d) => {
        const inp = document.getElementById('input-startDate');
        if (!inp) throw new Error('#input-startDate not found');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, d);
        inp.dispatchEvent(new Event('input',  { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
      }, dateStr);
      await page.waitForTimeout(300);
    }
    console.log(`📆 Date: ${dateStr}`);

    // COURT — open with focus+Space, click option by name
    await page.evaluate((name) => {
      const inp = document.getElementById('input-resource');
      if (!inp) throw new Error('#input-resource not found');
      inp.focus();
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', keyCode: 32, bubbles: true }));
      inp.dispatchEvent(new KeyboardEvent('keyup',   { key: ' ', code: 'Space', keyCode: 32, bubbles: true }));
    }, courtName);
    await page.waitForTimeout(500);
    await page.evaluate((name) => {
      const opts = Array.from(document.querySelectorAll('.select__option')).filter(o => o.offsetParent);
      const norm = s => s.trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
      const t = opts.find(o => norm(o.textContent) === norm(name));
      if (!t) throw new Error(`Court "${name}" not found. Options: ${opts.map(o => o.textContent.trim()).join(', ')}`);
      t.click();
    }, courtName);
    await page.waitForTimeout(400);
    console.log(`🏓 Court: ${courtName}`);

    // START TIME — open, filter, click
    await page.evaluate(() => {
      const inp = document.getElementById('input-startTime');
      if (!inp) throw new Error('#input-startTime not found');
      inp.focus();
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', keyCode: 32, bubbles: true }));
      inp.dispatchEvent(new KeyboardEvent('keyup',   { key: ' ', code: 'Space', keyCode: 32, bubbles: true }));
    });
    await page.waitForTimeout(500);
    await page.evaluate((text) => {
      const inp = document.getElementById('input-startTime');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, text);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }, startType);
    await page.waitForTimeout(400);
    await page.evaluate((disp) => {
      const opts = Array.from(document.querySelectorAll('.select__option')).filter(o => o.offsetParent);
      const norm = s => s.trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
      const t = opts.find(o => norm(o.textContent) === norm(disp));
      if (!t) throw new Error(`Start "${disp}" not found. Options: ${opts.map(o => o.textContent.trim()).join(', ')}`);
      t.click();
    }, startDisp);
    await page.waitForTimeout(400);
    console.log(`⏰ Start: ${startDisp}`);

    // END TIME — open, filter, click
    await page.evaluate(() => {
      const inp = document.getElementById('input-endTime');
      if (!inp) throw new Error('#input-endTime not found');
      inp.focus();
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', keyCode: 32, bubbles: true }));
      inp.dispatchEvent(new KeyboardEvent('keyup',   { key: ' ', code: 'Space', keyCode: 32, bubbles: true }));
    });
    await page.waitForTimeout(500);
    await page.evaluate((text) => {
      const inp = document.getElementById('input-endTime');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, text);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }, endType);
    await page.waitForTimeout(400);
    await page.evaluate((disp) => {
      const opts = Array.from(document.querySelectorAll('.select__option')).filter(o => o.offsetParent);
      const norm = s => s.trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
      const t = opts.find(o => norm(o.textContent) === norm(disp));
      if (!t) throw new Error(`End "${disp}" not found. Options: ${opts.map(o => o.textContent.trim()).join(', ')}`);
      t.click();
    }, endDisp);
    await page.waitForTimeout(400);
    console.log(`⏰ End: ${endDisp}`);

    // SUBMIT
    // FIX: use element.click() via evaluate() instead of page.getByRole().click().
    // Playtomic now wraps the form in a Modal with a permanent backdrop
    // (position:fixed; inset:0; pointer-events:auto). Playwright headless flags
    // this backdrop as intercepting all .click() actions inside the form.
    // element.click() calls the DOM method directly, bypassing that check entirely.
    await takeScreenshot(page, booking.id, 'before-submit');
    await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find(b => b.textContent.trim() === 'Create');
      if (!btn) throw new Error('Create button not found in DOM');
      btn.click();
    });
    await page.waitForTimeout(3000);
    await takeScreenshot(page, booking.id, 'after-submit');

    if (page.url().includes('/add/block'))
      throw new Error('Still on form after submit — check screenshot for error');

    console.log('✅ Blocking created via browser.');

  } finally {
    await browser.close();
  }
}

// ── TIME HELPERS ──────────────────────────────────────────────────────────────
// All UI times must be in club local time (America/Toronto).
// The Playtomic Manager form shows and accepts local time only.
// Webhook startTime/endTime arrive as UTC ISO strings — convert before use.

const CLUB_TZ = 'America/Toronto';

function pad(n) { return String(n).padStart(2, '0'); }

// Extract local {h, m} in club timezone from a UTC Date
function localHM(d) {
  const s = d.toLocaleTimeString('en-CA', { timeZone: CLUB_TZ, hour12: false, hour: '2-digit', minute: '2-digit' });
  const [h, m] = s.split(':').map(Number);
  return { h, m };
}

// "2026-03-19" in club local timezone
function toDateStr(d) {
  return d.toLocaleDateString('en-CA', { timeZone: CLUB_TZ }); // en-CA → YYYY-MM-DD
}

// "18:00" in club local timezone — for direct API calls
function toTimeStr(d) {
  const { h, m } = localHM(d);
  return `${pad(h)}:${pad(m)}`;
}

// "2026-04-05T21:00:00" — local datetime WITHOUT timezone offset
// Verified from working Playtomic API response — no Z, no milliseconds
function toLocalISOString(d) {
  const date = d.toLocaleDateString('en-CA', { timeZone: CLUB_TZ });
  const { h, m } = localHM(d);
  return `${date}T${pad(h)}:${pad(m)}:00`;
}

// "6:00" — typed into filter box (no leading zero, 12h, local time)
function toTypeStr(d) {
  let { h, m } = localHM(d);
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return `${h}:${pad(m)}`;
}

// "06:00 p.m." — exact dropdown option text (local time)
// norm() in pickOption handles both "p.m." and "PM" formats across browsers
function toDisplayTime(d) {
  let { h, m } = localHM(d);
  const mer = h >= 12 ? 'p.m.' : 'a.m.';
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return `${pad(h)}:${pad(m)} ${mer}`;
}

// ── SCREENSHOT ────────────────────────────────────────────────────────────────
async function takeScreenshot(page, id, label) {
  try {
    const b64 = (await page.screenshot()).toString('base64');
    console.log(`📸 [${id}-${label}] data:image/png;base64,${b64}`);
  } catch (_) {}
}

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(CONFIG.PORT, () =>
  console.log(`🚀 Padel Junction Playtomic Blocker on port ${CONFIG.PORT}`)
);
