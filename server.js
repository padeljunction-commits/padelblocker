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

    // Open the court React-Select by clicking its control element twice
    // (first click focuses, second opens — verified behaviour on React-Select)
    const courtControl = page.locator('#input-resource').locator('xpath=ancestor::div[contains(@class,"select__control")]').first();
    await courtControl.waitFor({ timeout: 10000 });
    await courtControl.click();
    await page.waitForTimeout(300);
    await courtControl.click();
    await page.waitForTimeout(400);

    // Wait for options to appear then click the right one
    await page.waitForSelector('.select__option', { timeout: 5000 });
    const courtOptions = await page.locator('.select__option').all();
    let courtClicked = false;
    for (const opt of courtOptions) {
      const text = await opt.textContent();
      if (text?.trim() === courtName) {
        await opt.click();
        courtClicked = true;
        break;
      }
    }
    if (!courtClicked) throw new Error(`Court option "${courtName}" not found in dropdown`);
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

    // Open start time dropdown the same way — click the control twice
    const startControl = page.locator('#input-startTime').locator('xpath=ancestor::div[contains(@class,"select__control")]').first();
    await startControl.waitFor({ timeout: 5000 });
    await startControl.click();
    await page.waitForTimeout(300);
    await startControl.click();
    await page.waitForTimeout(300);
    await page.keyboard.type(startType);
    await page.waitForTimeout(300);
    await page.waitForSelector('.select__option', { timeout: 5000 });
    const startOptions = await page.locator('.select__option').all();
    let startClicked = false;
    for (const opt of startOptions) {
      const text = await opt.textContent();
      if (text?.trim() === startDisp) { await opt.click(); startClicked = true; break; }
    }
    if (!startClicked) throw new Error(`Start time option "${startDisp}" not found`);
    await page.waitForTimeout(300);
    console.log(`⏰ Start time set: ${startDisp}`);

    // ── STEP 7: SET END TIME ──────────────────────────────────────────────
    // Open end time dropdown
    const endControl = page.locator('#input-endTime').locator('xpath=ancestor::div[contains(@class,"select__control")]').first();
    await endControl.waitFor({ timeout: 5000 });
    await endControl.click();
    await page.waitForTimeout(300);
    await endControl.click();
    await page.waitForTimeout(300);
    await page.keyboard.type(endType);
    await page.waitForTimeout(300);
    await page.waitForSelector('.select__option', { timeout: 5000 });
    const endOptions = await page.locator('.select__option').all();
    let endClicked = false;
    for (const opt of endOptions) {
      const text = await opt.textContent();
      if (text?.trim() === endDisp) { await opt.click(); endClicked = true; break; }
    }
    if (!endClicked) throw new Error(`End time option "${endDisp}" not found`);
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
