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
 * FIX 1 (Apr 2026) — Backdrop / Create button:
 *   Playtomic wrapped the form in a Modal with a permanent backdrop
 *   (position:fixed; inset:0; pointer-events:auto). Playwright headless flags
 *   this as intercepting all .click() actions. Fix: use element.click() via
 *   page.evaluate() for every click inside the form, bypassing the check.
 *
 * FIX 2 (Apr 2026) — Date field:
 *   The date field is React-controlled and ignores nativeSetter + synthetic
 *   events. The URL ?date= param also does not pre-fill it. The only reliable
 *   approach: click the field to open the calendar picker, navigate to the
 *   correct month, then click the day button (identified by aria-label = the
 *   day number, which distinguishes current-month days from adjacent-month
 *   overflow days whose aria-labels are "Mon DD").
 *   page.locator('#input-startDate').click() is safe at this step because it
 *   runs BEFORE the time dropdowns trigger the backdrop state change.
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
    // ── LOGIN ────────────────────────────────────────────────────────────────
    console.log('🔐 Logging in...');
    await page.goto('https://manager.playtomic.io/auth/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByRole('textbox', { name: 'Email' }).waitFor({ timeout: 15000 });
    await page.getByRole('textbox', { name: 'Email' }).fill(CONFIG.PLAYTOMIC_EMAIL);
    await page.getByRole('textbox', { name: 'Password' }).fill(CONFIG.PLAYTOMIC_PASSWORD);
    await page.getByRole('button', { name: 'Log In' }).click();
    await page.waitForFunction(() => !window.location.pathname.includes('/auth/login'), { timeout: 30000 });
    await page.waitForTimeout(2000);
    console.log('✅ Logged in.');

    // Read ROLE_TENANT_MANAGER token from localStorage
    const token = await page.evaluate((tenantId) => {
      const auth = JSON.parse(localStorage.getItem('playtomic:auth') || '{}');
      return auth?.accessTokens?.tenant?.[tenantId]?.value || null;
    }, CONFIG.PLAYTOMIC_TENANT_ID);

    if (token) {
      cachedAuthToken = token;
      console.log('🔑 ROLE_TENANT_MANAGER token read from localStorage.');
    } else {
      throw new Error('Tenant token not found in localStorage after login.');
    }

    const start     = new Date(booking.startTime);
    const end       = new Date(booking.endTime);
    const courtNum  = booking.court.match(/\d+/)?.[0] || '1';
    const courtName = `Padel ${courtNum}`;
    const startDisp = toDisplayTime(start);
    const endDisp   = toDisplayTime(end);
    const startType = toTypeStr(start);
    const endType   = toTypeStr(end);
    const dateStr   = toDateStr(start);                          // "2026-04-25"
    const [tYear, tMonth, tDay] = dateStr.split('-').map(Number); // [2026, 4, 25]

    // ── OPEN FORM ────────────────────────────────────────────────────────────
    await page.goto(
      `https://manager.playtomic.io/dashboard/schedule/add/block?tid=${CONFIG.PLAYTOMIC_TENANT_ID}`,
      { waitUntil: 'domcontentloaded', timeout: 60000 }
    );
    await page.locator('#input-resource').waitFor({ timeout: 15000 });
    await page.waitForTimeout(500);
    console.log('📝 Form loaded.');

    // ── TITLE — nativeSetter (no click needed) ────────────────────────────────
    await page.evaluate((title) => {
      const inp = document.getElementById('input-name');
      if (!inp) throw new Error('#input-name not found');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, title);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }, `CatchCorner – ${booking.customer || 'Booking'}`);

    // ── DATE — calendar picker approach ──────────────────────────────────────
    // The date field is React-controlled and ignores nativeSetter + synthetic
    // events. The URL ?date= param also doesn't pre-fill it. Only real
    // interaction with the calendar picker works.
    //
    // page.locator().click() is SAFE here — it runs before the time dropdowns
    // trigger the React re-render that locks the backdrop into blocking state.
    await page.locator('#input-startDate').click();
    await page.waitForTimeout(400); // calendar opens

    const MONTH_NAMES = ['January','February','March','April','May','June',
                         'July','August','September','October','November','December'];

    // Navigate calendar to the correct month/year (max 24 steps = 2 years)
    for (let attempt = 0; attempt < 24; attempt++) {
      const { curMonth, curYear } = await page.evaluate((months) => {
        const all = Array.from(document.querySelectorAll('*'))
          .filter(el => el.offsetParent && el.children.length === 0);
        const mEl = all.find(el => months.includes(el.textContent.trim()));
        const yEl = all.find(el => /^\d{4}$/.test(el.textContent.trim()));
        return {
          curMonth: mEl ? months.indexOf(mEl.textContent.trim()) + 1 : null,
          curYear:  yEl ? parseInt(yEl.textContent.trim()) : null,
        };
      }, MONTH_NAMES);

      if (curMonth === tMonth && curYear === tYear) break;

      const diff = (tYear - curYear) * 12 + (tMonth - curMonth);
      // Click prev (<) or next (>) nav button via evaluate
      await page.evaluate((goNext) => {
        const MONTHS = ['January','February','March','April','May','June',
                        'July','August','September','October','November','December'];
        const all = Array.from(document.querySelectorAll('*'))
          .filter(el => el.offsetParent && el.children.length === 0);
        const mEl = all.find(el => MONTHS.includes(el.textContent.trim()));
        if (!mEl) throw new Error('Calendar month element not found');
        // Walk up until we find the header container with exactly 2 nav buttons
        let container = mEl.parentElement;
        for (let i = 0; i < 5; i++) {
          const btns = Array.from(container.querySelectorAll('button')).filter(b => b.offsetParent);
          if (btns.length >= 2) {
            (goNext ? btns[btns.length - 1] : btns[0]).click();
            return;
          }
          container = container.parentElement;
        }
        throw new Error('Calendar nav buttons not found');
      }, diff > 0);
      await page.waitForTimeout(300);
    }

    // Click the target day.
    // Current-month days have aria-label = just the number ("25").
    // Adjacent-month overflow days have aria-label = "Mon DD" ("Apr 25") — excluded.
    await page.evaluate((day) => {
      const btn = Array.from(document.querySelectorAll('button'))
        .find(b => b.offsetParent && b.getAttribute('aria-label') === String(day));
      if (!btn) throw new Error(`Calendar day ${day} not found`);
      btn.click();
    }, tDay);
    await page.waitForTimeout(300);
    console.log(`📆 Date: ${dateStr}`);

    // ── COURT ─────────────────────────────────────────────────────────────────
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

    // ── START TIME ────────────────────────────────────────────────────────────
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

    // ── END TIME ──────────────────────────────────────────────────────────────
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

    // ── SUBMIT ────────────────────────────────────────────────────────────────
    // FIX: element.click() via evaluate bypasses Playwright's actionability
    // hit-test which incorrectly flags the Modal backdrop as intercepting.
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
const CLUB_TZ = 'America/Toronto';

function pad(n) { return String(n).padStart(2, '0'); }

function localHM(d) {
  const s = d.toLocaleTimeString('en-CA', { timeZone: CLUB_TZ, hour12: false, hour: '2-digit', minute: '2-digit' });
  const [h, m] = s.split(':').map(Number);
  return { h, m };
}

// "2026-04-25" — YYYY-MM-DD in Toronto timezone (en-CA locale)
function toDateStr(d) {
  return d.toLocaleDateString('en-CA', { timeZone: CLUB_TZ });
}

// "2026-04-05T21:00:00" — local datetime, no Z, no ms (Playtomic API format)
function toLocalISOString(d) {
  const date = d.toLocaleDateString('en-CA', { timeZone: CLUB_TZ });
  const { h, m } = localHM(d);
  return `${date}T${pad(h)}:${pad(m)}:00`;
}

// "6:00" — filter box input (no leading zero, 12h)
function toTypeStr(d) {
  let { h, m } = localHM(d);
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return `${h}:${pad(m)}`;
}

// "06:00 p.m." — exact dropdown option text
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
