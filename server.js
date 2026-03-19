/**
 * PADEL JUNCTION — PLAYTOMIC AUTO-BLOCKER
 * ----------------------------------------
 * Flow fully verified live via Claude in Chrome (March 19, 2026).
 * Multiple test blockings created successfully.
 *
 * KEY INSIGHT: React-Select dropdowns need TWO clicks to open:
 *   - First click: focuses the element
 *   - Second click: opens the dropdown list
 * Then type to filter, then JS-click the .select__option by text.
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

// Court dropdown X coordinates (verified from live DOM inspection)
// Used for mouse clicks since React-Select requires real pointer events
const COURT_DROPDOWN_X = 748;
const START_TIME_X     = 573;
const END_TIME_X       = 805;
const DROPDOWNS_Y      = 302;

// ── HEALTH CHECK ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Padel Junction Playtomic Blocker' });
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

  console.log(`📥 Booking received: ${booking.court} @ ${booking.startTime} – ${booking.endTime}`);
  res.json({ status: 'accepted' });

  try {
    await createPlaytomicBlocking(booking);
    console.log(`✅ Blocking created for booking ${booking.id}`);
  } catch (err) {
    console.error(`❌ Failed to create blocking for ${booking.id}: ${err.message}`);
  }
});

// ── PLAYTOMIC AUTOMATION ──────────────────────────────────────────────────────
async function createPlaytomicBlocking(booking) {
  const launchOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  };
  if (CONFIG.CHROMIUM_PATH) launchOptions.executablePath = CONFIG.CHROMIUM_PATH;

  const browser = await chromium.launch(launchOptions);
  const context  = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page     = await context.newPage();

  try {
    // ── STEP 1: LOG IN ────────────────────────────────────────────────────
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

    // ── STEP 2: OPEN CREATE BLOCKING FORM ────────────────────────────────
    const blockUrl = `https://manager.playtomic.io/dashboard/schedule/add/block?tid=${CONFIG.PLAYTOMIC_TENANT_ID}`;
    await page.goto(blockUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.getByPlaceholder('E.g.: Maintenance').waitFor({ timeout: 15000 });
    await page.waitForTimeout(500);
    console.log('📝 Form loaded.');
    await takeScreenshot(page, booking.id, '01-form-loaded');

    // ── STEP 3: FILL TITLE ────────────────────────────────────────────────
    await page.getByPlaceholder('E.g.: Maintenance').fill(`CatchCorner – ${booking.customer}`);
    console.log('📝 Title filled.');

    // ── STEP 4: SELECT COURT ──────────────────────────────────────────────
    // React-Select needs TWO clicks: first focuses, second opens the list
    const courtNum  = booking.court.match(/\d+/)?.[0] || '1';
    const courtName = `Padel ${courtNum}`;

    await page.mouse.click(COURT_DROPDOWN_X, DROPDOWNS_Y); // focus
    await page.waitForTimeout(200);
    await page.mouse.click(COURT_DROPDOWN_X, DROPDOWNS_Y); // open
    await page.waitForTimeout(400);

    // Click the option by text using JS (reliable after dropdown is open)
    await page.evaluate((name) => {
      const opt = Array.from(document.querySelectorAll('.select__option'))
        .find(o => o.textContent.trim() === name);
      if (!opt) throw new Error(`Court option "${name}" not found`);
      opt.click();
    }, courtName);
    await page.waitForTimeout(400);
    console.log(`🏓 Court set: ${courtName}`);

    // ── STEP 5: SET DATE (if not today) ───────────────────────────────────
    const start   = new Date(booking.startTime);
    const end     = new Date(booking.endTime);
    const dateStr = toDateStr(start);

    const currentDate = await page.locator('#input-startDate').inputValue().catch(() => '');
    if (currentDate && currentDate !== dateStr) {
      await page.locator('#input-startDate').click();
      await page.waitForTimeout(300);
      await page.keyboard.press('Control+A');
      await page.keyboard.type(dateStr);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(400);
      await page.keyboard.press('Escape').catch(() => {});
      console.log(`📆 Date set: ${dateStr}`);
    } else {
      console.log(`📆 Date already correct: ${dateStr}`);
    }

    // ── STEP 6: SET START TIME ────────────────────────────────────────────
    // Same two-click pattern, then type to filter, then JS-click option
    const startDisp = toDisplayTime(start);  // "04:00 p.m."
    const endDisp   = toDisplayTime(end);    // "05:30 p.m."
    const startType = toTypeStr(start);      // "4:00"
    const endType   = toTypeStr(end);        // "5:30"

    await page.mouse.click(START_TIME_X, DROPDOWNS_Y); // focus
    await page.waitForTimeout(200);
    await page.mouse.click(START_TIME_X, DROPDOWNS_Y); // open
    await page.waitForTimeout(300);
    await page.keyboard.type(startType);
    await page.waitForTimeout(300);
    await page.evaluate((disp) => {
      const opt = Array.from(document.querySelectorAll('.select__option'))
        .filter(o => o.offsetParent)
        .find(o => o.textContent.trim() === disp);
      if (!opt) throw new Error(`Start time option "${disp}" not found`);
      opt.click();
    }, startDisp);
    await page.waitForTimeout(300);
    console.log(`⏰ Start time set: ${startDisp}`);

    // ── STEP 7: SET END TIME ──────────────────────────────────────────────
    await page.mouse.click(END_TIME_X, DROPDOWNS_Y); // focus
    await page.waitForTimeout(200);
    await page.mouse.click(END_TIME_X, DROPDOWNS_Y); // open
    await page.waitForTimeout(300);
    await page.keyboard.type(endType);
    await page.waitForTimeout(300);
    await page.evaluate((disp) => {
      const opt = Array.from(document.querySelectorAll('.select__option'))
        .filter(o => o.offsetParent)
        .find(o => o.textContent.trim() === disp);
      if (!opt) throw new Error(`End time option "${disp}" not found`);
      opt.click();
    }, endDisp);
    await page.waitForTimeout(300);
    console.log(`⏰ End time set: ${endDisp}`);

    await takeScreenshot(page, booking.id, '02-form-filled');

    // ── STEP 8: SUBMIT ────────────────────────────────────────────────────
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForTimeout(2500);
    console.log('🖱️  Create clicked.');
    await takeScreenshot(page, booking.id, '03-after-submit');

    const urlOk = !page.url().includes('/add/block');
    if (urlOk) {
      console.log('✅ Blocking saved — navigated away from form.');
    } else {
      console.warn('⚠️  Still on form — check screenshot for errors.');
    }

  } catch (err) {
    await takeScreenshot(page, booking.id, 'error');
    throw err;
  } finally {
    await browser.close();
  }
}

// ── TIME HELPERS ──────────────────────────────────────────────────────────────

// "2026-03-19"
function toDateStr(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// "4:00" — typed to filter dropdown (no leading zero, no am/pm)
function toTypeStr(date) {
  let h = date.getUTCHours();
  const m = date.getUTCMinutes();
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')}`;
}

// "04:00 p.m." — exact .select__option text (verified from live UI)
function toDisplayTime(date) {
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
    const b64    = buffer.toString('base64');
    console.log(`📸 [${bookingId}-${label}] paste into browser: data:image/png;base64,${b64}`);
  } catch (_) {}
}

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(CONFIG.PORT, () => {
  console.log(`🚀 Padel Junction Playtomic Blocker running on port ${CONFIG.PORT}`);
});
