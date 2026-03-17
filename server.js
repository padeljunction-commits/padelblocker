/**
 * PADEL JUNCTION — PLAYTOMIC AUTO-BLOCKER
 * Selectors verified via Playwright Codegen on real Playtomic Manager UI (March 2026)
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

  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page    = await context.newPage();

  try {
    // ── STEP 1: LOG IN ────────────────────────────────────────────────────
    console.log('🔐 Logging in...');
    await page.goto('https://manager.playtomic.io/auth/login', {
      waitUntil: 'domcontentloaded', timeout: 60000,
    });

    await page.getByRole('textbox', { name: 'Email' }).fill(CONFIG.PLAYTOMIC_EMAIL);
    await page.getByRole('textbox', { name: 'Password' }).fill(CONFIG.PLAYTOMIC_PASSWORD);
    await page.getByRole('button', { name: 'Log In' }).click();

    // Wait for schedule to appear after login
    await page.waitForURL('**/schedule**', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2000);
    console.log('✅ Logged in.');

    // ── STEP 2: NAVIGATE TO SCHEDULE FOR THE RIGHT DATE ───────────────────
    const start  = new Date(booking.startTime);
    const end    = new Date(booking.endTime);
    const scheduleUrl = `https://manager.playtomic.io/dashboard/schedule?tid=${CONFIG.PLAYTOMIC_TENANT_ID}`;
    await page.goto(scheduleUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000);
    console.log('📅 Schedule loaded.');

    // Navigate to the correct date using the calendar
    await navigateToDate(page, start);

    // ── STEP 3: CLICK THE 6:00 AM CELL IN THE CORRECT COURT COLUMN ─────────
    // We always click the 6:00 AM row — courts never open this early so it
    // is guaranteed to be empty and will always open a new booking panel,
    // never an existing booking. We override all values in the form anyway.
    const courtNum = booking.court.match(/\d+/)?.[0] || '1';
    const colIndex = courtNum === '1' ? 2 : 3;

    // Scroll the schedule grid to the top to reveal 6:00 AM row
    // Try all known FullCalendar scroller selectors
    await page.evaluate(() => {
      const selectors = [
        '.fc-scroller',
        '.fc-time-grid-container',
        '.fc-scroller-liquid-absolute',
        '[class*="fc-scroller"]',
        '[class*="scroller"]',
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.scrollHeight > el.clientHeight) {
          el.scrollTop = 0;
        }
      }
    });
    await page.waitForTimeout(800);

    // Find the 6:00 AM row by looking for the time label, then click that row's court cell
    const timeLabel = page.locator('td, th').filter({ hasText: /^06:00/ }).first();
    await timeLabel.waitFor({ timeout: 10000 });
    const timeRow = timeLabel.locator('xpath=ancestor::tr');
    const emptyCell = timeRow.locator(`td:nth-child(${colIndex})`);
    await emptyCell.click({ force: true });
    await page.waitForTimeout(1000);
    console.log(`🖱️  Clicked 6:00 AM cell in Padel ${courtNum} column`);

    // ── STEP 4: SWITCH TO BLOCKING ────────────────────────────────────────
    await page.getByRole('button', { name: 'Regular booking' }).click();
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: /Blocking/i }).click();
    await page.waitForTimeout(1000);
    console.log('🔒 Switched to Blocking.');

    // ── STEP 5: FILL TITLE ────────────────────────────────────────────────
    const courtName = `Padel ${courtNum}`;
    await page.getByRole('textbox', { name: 'Title' }).fill(`CatchCorner – ${booking.customer}`);
    await page.getByRole('textbox', { name: 'Title' }).press('Tab');
    console.log('📝 Title filled.');

    // ── STEP 6: SET COURT ─────────────────────────────────────────────────
    // Click the current court dropdown value, then select the right court
    const courtDropdown = page.locator('div').filter({ hasText: new RegExp(`^Padel \\d$`) }).first();
    await courtDropdown.click();
    await page.waitForTimeout(500);
    // Select by text in the react-select dropdown
    await page.getByText(courtName, { exact: true }).last().click();
    await page.waitForTimeout(500);
    console.log(`🏓 Court set to: ${courtName}`);

    // ── STEP 7: SET DATE ──────────────────────────────────────────────────
    await page.getByRole('button', { name: 'Date' }).click();
    await page.waitForTimeout(500);

    // If the calendar isn't on the right month, navigate to it
    await navigateCalendarToMonth(page, start);

    // Click the correct day
    const day = start.getDate().toString();
    await page.getByRole('gridcell', { name: day }).click();
    await page.waitForTimeout(500);
    console.log(`📆 Date set: ${start.toISOString().split('T')[0]}`);

    // ── STEP 8: SET START TIME ────────────────────────────────────────────
    // Times appear as a scrollable list — click the matching time text
    const startTimeStr = toPickerFormat(start);
    const endTimeStr   = toPickerFormat(end);

    // The start time picker — click current start time display to open list
    const startTimeTrigger = page.locator('div').filter({ hasText: new RegExp(`^\\d{1,2}:\\d{2} (AM|PM)$`) }).nth(2);
    await startTimeTrigger.click();
    await page.waitForTimeout(500);
    await page.getByText(startTimeStr, { exact: true }).click();
    await page.waitForTimeout(500);
    console.log(`⏰ Start time set: ${startTimeStr}`);

    // ── STEP 9: SET END TIME ──────────────────────────────────────────────
    await page.getByText(endTimeStr, { exact: true }).click();
    await page.waitForTimeout(500);
    console.log(`⏰ End time set: ${endTimeStr}`);

    // ── STEP 10: SCREENSHOT BEFORE SUBMIT ─────────────────────────────────
    await takeScreenshot(page, booking.id, 'before-submit');

    // ── STEP 11: SUBMIT ───────────────────────────────────────────────────
    await page.getByRole('button', { name: 'Create' }).click();
    await page.waitForTimeout(2000);
    console.log('✅ Create clicked.');

    await takeScreenshot(page, booking.id, 'after-submit');

  } catch (err) {
    await takeScreenshot(page, booking.id, 'error');
    throw err;
  } finally {
    await browser.close();
  }
}

// ── NAVIGATE SCHEDULE TO DATE ─────────────────────────────────────────────────
async function navigateToDate(page, targetDate) {
  // Click the date pill in the schedule header to open the date picker
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const monthStr = months[targetDate.getMonth()];
  const dayStr   = targetDate.getDate();

  // Click the date navigation button (shows current date like "Tue, Mar 17")
  const datePill = page.locator(`button:has-text("${monthStr}")`).first();
  if (await datePill.count() > 0) {
    await datePill.click();
    await page.waitForTimeout(500);
    await navigateCalendarToMonth(page, targetDate);
    await page.getByRole('gridcell', { name: dayStr.toString() }).click();
    await page.waitForTimeout(1000);
  }
  console.log(`📆 Navigated to: ${targetDate.toISOString().split('T')[0]}`);
}

// ── NAVIGATE CALENDAR POPUP TO CORRECT MONTH ─────────────────────────────────
async function navigateCalendarToMonth(page, targetDate) {
  const months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  const targetMonth = months[targetDate.getMonth()];
  const targetYear  = targetDate.getFullYear();

  for (let i = 0; i < 12; i++) {
    const header = await page.locator('[class*="calendar"] [class*="month"], [class*="DayPicker"] .DayPicker-Caption').first().textContent().catch(() => '');
    if (header.includes(targetMonth) && header.includes(targetYear.toString())) break;
    // Click next month button
    await page.locator('button[aria-label*="next"], button[aria-label*="Next"], [class*="next"]').last().click();
    await page.waitForTimeout(300);
  }
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

// Converts JS Date to Playtomic time picker format: "01:30 PM"
function toPickerFormat(date) {
  let h = date.getUTCHours();
  const m   = date.getUTCMinutes();
  const mer = h >= 12 ? 'PM' : 'AM';
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ${mer}`;
}

async function takeScreenshot(page, bookingId, label) {
  try {
    const buffer = await page.screenshot({ fullPage: false });
    const b64 = buffer.toString('base64');
    console.log(`📸 Screenshot [${bookingId}-${label}] — paste into browser address bar:`);
    console.log(`data:image/png;base64,${b64}`);
  } catch (_) {}
}

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(CONFIG.PORT, () => {
  console.log(`🚀 Padel Junction Playtomic Blocker running on port ${CONFIG.PORT}`);
});
