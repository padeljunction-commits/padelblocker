/**
 * PADEL JUNCTION — PLAYTOMIC AUTO-BLOCKER
 * ----------------------------------------
 * Selectors and flow verified via live Claude in Chrome testing (March 19, 2026)
 * Successfully created a test blocking on Padel 2, 11:00 a.m. - 12:30 p.m.
 *
 * Verified flow:
 * 1. Navigate to /dashboard/schedule/add/block?tid=... — opens form directly
 * 2. Click Court dropdown → select Padel 1 or Padel 2
 * 3. Click Start time → type time to filter → click option
 * 4. Click End time → type time to filter → click option
 * 5. Click Create → "Blocking successfully created" toast appears
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

    // Wait until redirected away from login page
    await page.waitForFunction(
      () => !window.location.pathname.includes('/auth/login'),
      { timeout: 30000 }
    );
    await page.waitForTimeout(1500);
    console.log('✅ Logged in.');

    // ── STEP 2: NAVIGATE TO CREATE BLOCKING FORM ──────────────────────────
    // Verified: this URL opens the Create Blocking form directly
    const blockUrl = `https://manager.playtomic.io/dashboard/schedule/add/block?tid=${CONFIG.PLAYTOMIC_TENANT_ID}`;
    await page.goto(blockUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // Wait for the form to appear — it can take a moment to render
    await page.getByPlaceholder('E.g.: Maintenance').waitFor({ timeout: 15000 });
    console.log('📝 Create Blocking form loaded.');
    await takeScreenshot(page, booking.id, '01-form-loaded');

    // ── STEP 3: SET COURT ─────────────────────────────────────────────────
    // Verified: simple dropdown showing "Padel 1" and "Padel 2"
    const courtNum  = booking.court.match(/\d+/)?.[0] || '1';
    const courtName = `Padel ${courtNum}`;

    await page.getByRole('combobox', { name: /court/i })
      .or(page.locator('[class*="court"] select, select').first())
      .or(page.locator('text=Select...').first())
      .click().catch(() => {
        // fallback — click the court dropdown area directly
        return page.locator('.sc-', { hasText: 'Select' }).first().click();
      });

    // Wait for dropdown and click the court option
    await page.getByText(courtName, { exact: true }).waitFor({ timeout: 5000 });
    await page.getByText(courtName, { exact: true }).click();
    console.log(`🏓 Court set: ${courtName}`);

    // ── STEP 4: SET DATE ──────────────────────────────────────────────────
    // The date field defaults to today — only need to change if different date
    const start   = new Date(booking.startTime);
    const end     = new Date(booking.endTime);
    const dateStr = toDateStr(start);  // "2026-03-19"

    const currentDate = await page.locator('input[type="text"][value]').first().inputValue().catch(() => '');
    if (currentDate !== dateStr) {
      const dateInput = page.locator(`input[value="${currentDate}"]`).first();
      await dateInput.triple_click ? dateInput.click({ clickCount: 3 }) : dateInput.click();
      await page.keyboard.press('Control+A');
      await page.keyboard.type(dateStr);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
      console.log(`📆 Date changed to: ${dateStr}`);
    } else {
      console.log(`📆 Date already correct: ${dateStr}`);
    }

    // ── STEP 5: SET START TIME ────────────────────────────────────────────
    // Verified: clicking the field and typing filters the dropdown list
    const startDisp = toDisplayTime(start);  // "11:00 a.m."
    const endDisp   = toDisplayTime(end);    // "12:30 p.m."

    // Click Start time field
    await page.getByPlaceholder('Select...').first().click();
    await page.waitForTimeout(300);

    // Type to filter — verified this works perfectly
    await page.keyboard.type(toTypeStr(start));  // "11:00"
    await page.waitForTimeout(300);

    // Click the a.m./p.m. option
    await page.getByText(startDisp, { exact: true }).click();
    console.log(`⏰ Start time set: ${startDisp}`);

    // ── STEP 6: SET END TIME ──────────────────────────────────────────────
    await page.getByPlaceholder('Select...').first().click();
    await page.waitForTimeout(300);
    await page.keyboard.type(toTypeStr(end));  // "12:30"
    await page.waitForTimeout(300);
    await page.getByText(endDisp, { exact: true }).click();
    console.log(`⏰ End time set: ${endDisp}`);

    await takeScreenshot(page, booking.id, '02-form-filled');

    // ── STEP 7: SUBMIT ────────────────────────────────────────────────────
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForTimeout(2500);
    console.log('🖱️  Create clicked.');

    await takeScreenshot(page, booking.id, '03-after-submit');

    // Verify success — look for the success toast
    const successToast = await page.locator('text="Blocking successfully created"').isVisible().catch(() => false);
    if (successToast) {
      console.log('✅ Confirmed: "Blocking successfully created" toast visible.');
    } else {
      // Also accept URL change as success signal
      const url = page.url();
      if (!url.includes('/add/block')) {
        console.log('✅ Confirmed: navigated away from form — blocking saved.');
      } else {
        console.warn('⚠️  Could not confirm success — check screenshot.');
      }
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

// "11:00" — what to type into the time field to filter dropdown
function toTypeStr(date) {
  let h = date.getUTCHours();
  const m = date.getUTCMinutes();
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')}`;
}

// "11:00 a.m." or "12:30 p.m." — exact dropdown option text (verified from live UI)
function toDisplayTime(date) {
  let h = date.getUTCHours();
  const m   = date.getUTCMinutes();
  const mer = h >= 12 ? 'p.m.' : 'a.m.';
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')} ${mer}`;
}

// ── SCREENSHOT (logged as base64 for Railway logs) ────────────────────────────
async function takeScreenshot(page, bookingId, label) {
  try {
    const buffer = await page.screenshot({ fullPage: false });
    const b64    = buffer.toString('base64');
    console.log(`📸 [${bookingId}-${label}] — paste into browser to view: data:image/png;base64,${b64}`);
  } catch (_) {}
}

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(CONFIG.PORT, () => {
  console.log(`🚀 Padel Junction Playtomic Blocker running on port ${CONFIG.PORT}`);
});
