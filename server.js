/**
 * PADEL JUNCTION — PLAYTOMIC AUTO-BLOCKER
 * ----------------------------------------
 * Receives a webhook from Google Apps Script when a non-Playtomic calendar
 * event is detected, then uses Playwright to log into Playtomic Manager and
 * create a Blocking — verified against real Playtomic Manager UI (March 2026).
 *
 * Flow observed in UI:
 *   1. Schedule page → click empty slot → "Create regular booking" panel opens
 *   2. Click "Regular booking" dropdown → select "Blocking"
 *   3. Fill: Title, Court (Padel 1 / Padel 2), Date, Start time, End time
 *   4. Click "Create"
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

  // Respond immediately so Apps Script doesn't time out
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

  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page    = await context.newPage();

  try {
    // ── STEP 1: LOG IN ────────────────────────────────────────────────────
    console.log('🔐 Logging in...');
    await page.goto('https://manager.playtomic.io/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.fill('input[type="email"]', CONFIG.PLAYTOMIC_EMAIL);
    await page.fill('input[type="password"]', CONFIG.PLAYTOMIC_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    console.log('✅ Logged in.');

    // ── STEP 2: GO TO SCHEDULE ────────────────────────────────────────────
    const scheduleUrl = `https://manager.playtomic.io/dashboard/schedule?tid=${CONFIG.PLAYTOMIC_TENANT_ID}`;
    await page.goto(scheduleUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('📅 Schedule loaded.');

    // ── STEP 3: NAVIGATE TO THE CORRECT DATE ─────────────────────────────
    const targetDate = new Date(booking.startTime);
    await navigateToDate(page, targetDate);

    // ── STEP 4: FIND THE CORRECT COURT COLUMN AND CLICK AN EMPTY CELL ──────
    const courtNum = booking.court.match(/\d+/)?.[0] || "1";
    const courtCol = courtNum === "1" ? "Padel 1" : "Padel 2";

    // Wait for the schedule grid to be present
    await page.waitForSelector('text="Padel 1"', { timeout: 15000 });
    await page.waitForTimeout(2000); // let the grid fully render

    // Find all column headers and determine the X centre of the right court column
    const headers = await page.locator('th, [class*="header"], [class*="column-header"]').all();
    let courtX = null;
    for (const h of headers) {
      const txt = await h.textContent().catch(() => '');
      if (txt.trim() === courtCol) {
        const box = await h.boundingBox();
        if (box) { courtX = box.x + box.width / 2; break; }
      }
    }

    // Fallback: use page text locator
    if (!courtX) {
      const headerLoc = page.locator(`text="${courtCol}"`).first();
      const box = await headerLoc.boundingBox();
      if (box) courtX = box.x + box.width / 2;
    }

    if (!courtX) throw new Error(`Could not find column for ${courtCol}`);

    // Click at the court X position, in the middle-ish vertical area of the schedule
    // Try multiple Y positions until the panel opens
    const viewportHeight = page.viewportSize().height;
    const yPositions = [300, 400, 250, 350, 450];
    let panelOpened = false;

    for (const y of yPositions) {
      await page.mouse.click(courtX, y);
      console.log(\`🖱️  Clicked ${courtCol} at y=${y}\`);
      await page.waitForTimeout(1000);

      // Check if any booking panel opened
      const panelVisible = await page.locator('button:has-text("Regular booking"), text="Create regular booking", text="Create blocking"').first().isVisible().catch(() => false);
      if (panelVisible) {
        panelOpened = true;
        console.log('✅ Booking panel opened.');
        break;
      }
    }

    if (!panelOpened) throw new Error('Could not open booking panel after multiple click attempts.');

    // ── STEP 5: SWITCH TO BLOCKING ────────────────────────────────────────
    // If "Create blocking" is already shown, skip the dropdown
    const alreadyBlocking = await page.locator('text="Create blocking"').first().isVisible().catch(() => false);

    if (!alreadyBlocking) {
      const typeDropdown = page.locator('button:has-text("Regular booking")').first();
      await typeDropdown.waitFor({ timeout: 8000 });
      await typeDropdown.click();
      await page.waitForTimeout(500);

      // Select "Blocking"
      await page.locator('text="Blocking"').last().click();
      console.log('🔒 Switched to Blocking type.');
      await page.waitForSelector('text="Create blocking"', { timeout: 8000 });
    } else {
      console.log('🔒 Blocking panel already open.');
    }

    // ── STEP 7: FILL TITLE ────────────────────────────────────────────────
    const titleInput = page.locator('input[placeholder="E.g.: Maintenance"]').first();
    await titleInput.waitFor({ timeout: 5000 });
    await titleInput.fill(`CatchCorner – ${booking.customer}`);

    // ── STEP 8: SELECT COURT ──────────────────────────────────────────────
    // Court dropdown currently shows the court we clicked — verify and adjust if needed
    const courtDropdown = page.locator('text="Court"').locator('..').locator('select, [role="combobox"]').first();
    try {
      await courtDropdown.selectOption({ label: courtCol });
    } catch {
      // Some Playtomic dropdowns are custom — try clicking and selecting
      const courtBtn = page.locator(`button:has-text("${courtCol}"), div[role="button"]:has-text("${courtCol}")`).first();
      if (await courtBtn.count() > 0) {
        await courtBtn.click();
        await page.locator(`text="${courtCol}"`).last().click();
      }
    }
    console.log(`🏓 Court set to: ${courtCol}`);

    // ── STEP 9: SET DATE ──────────────────────────────────────────────────
    // Format: 2026-03-17 (YYYY-MM-DD) — confirmed in UI
    const dateStr = targetDate.toISOString().split('T')[0];
    const dateInput = page.locator('input[type="date"], input[placeholder*="date" i]').first();
    await dateInput.waitFor({ timeout: 5000 });
    await dateInput.fill(dateStr);
    await dateInput.press('Tab');
    console.log(`📆 Date set: ${dateStr}`);

    // ── STEP 10: SET START TIME ───────────────────────────────────────────
    // Format: "01:30 p.m." — confirmed in UI
    const startStr = toPlaytomicTimeFormat(new Date(booking.startTime));
    const endStr   = toPlaytomicTimeFormat(new Date(booking.endTime));

    const timeInputs = page.locator('input[placeholder*="time" i], input[aria-label*="time" i], input[aria-label*="start" i]');
    const startInput = page.locator('input').filter({ has: page.locator(':scope[aria-label*="start" i]') }).first();

    // Target by proximity to "Start time" label
    const startTimeInput = page.locator('label:has-text("Start time") + * input, label:has-text("Start time") ~ * input').first();
    const endTimeInput   = page.locator('label:has-text("End time") + * input, label:has-text("End time") ~ * input').first();

    if (await startTimeInput.count() > 0) {
      await startTimeInput.triple_click ? startTimeInput.click({ clickCount: 3 }) : startTimeInput.click();
      await startTimeInput.fill(startStr);
      await startTimeInput.press('Tab');
    } else {
      // Fallback: find all time-looking inputs and use position
      const allInputs = await page.locator('input').all();
      for (const input of allInputs) {
        const val = await input.inputValue().catch(() => '');
        if (val.match(/\d{1,2}:\d{2}\s*[ap]\.m\./i)) {
          const label = await input.evaluate(el => {
            const form = el.closest('form') || el.closest('[role="dialog"]') || document;
            const labels = form.querySelectorAll('label');
            for (const l of labels) {
              if (l.htmlFor === el.id || l.contains(el)) return l.textContent;
            }
            return '';
          });
          if (label.toLowerCase().includes('start')) {
            await input.click({ clickCount: 3 });
            await input.fill(startStr);
            await input.press('Tab');
            break;
          }
        }
      }
    }
    console.log(`⏰ Start time set: ${startStr}`);

    if (await endTimeInput.count() > 0) {
      await endTimeInput.click({ clickCount: 3 });
      await endTimeInput.fill(endStr);
      await endTimeInput.press('Tab');
    } else {
      const allInputs = await page.locator('input').all();
      for (const input of allInputs) {
        const val = await input.inputValue().catch(() => '');
        if (val.match(/\d{1,2}:\d{2}\s*[ap]\.m\./i)) {
          const label = await input.evaluate(el => {
            const form = el.closest('form') || el.closest('[role="dialog"]') || document;
            const labels = form.querySelectorAll('label');
            for (const l of labels) {
              if (l.htmlFor === el.id || l.contains(el)) return l.textContent;
            }
            return '';
          });
          if (label.toLowerCase().includes('end')) {
            await input.click({ clickCount: 3 });
            await input.fill(endStr);
            await input.press('Tab');
            break;
          }
        }
      }
    }
    console.log(`⏰ End time set: ${endStr}`);

    // ── STEP 11: ADD NOTES ────────────────────────────────────────────────
    const notesInput = page.locator('textarea[placeholder*="Private notes" i]').first();
    if (await notesInput.count() > 0) {
      await notesInput.fill(`Auto-blocked from CatchCorner. Booking ID: ${booking.id}. Customer: ${booking.customer}`);
    }

    // ── STEP 12: TAKE PRE-SUBMIT SCREENSHOT ───────────────────────────────
    await takeScreenshot(page, booking.id, 'before-submit');

    // ── STEP 13: SUBMIT ───────────────────────────────────────────────────
    const createBtn = page.locator('button:has-text("Create")').last();
    await createBtn.waitFor({ timeout: 5000 });
    await createBtn.click();
    console.log('🖱️  Clicked Create.');

    // ── STEP 14: VERIFY ───────────────────────────────────────────────────
    await page.waitForTimeout(2000);
    await takeScreenshot(page, booking.id, 'after-submit');

    // Check for error messages
    const errorMsg = await page.locator('text=/error|failed|invalid/i').count();
    if (errorMsg > 0) {
      throw new Error('Page shows an error after submission — check screenshot.');
    }

    console.log(`✅ Blocking created: ${courtCol} on ${dateStr} ${startStr} – ${endStr}`);

  } catch (err) {
    await takeScreenshot(page, booking.id, 'error');
    throw err;
  } finally {
    await browser.close();
  }
}

// ── NAVIGATE TO DATE ──────────────────────────────────────────────────────────
// Uses the date picker in the schedule header to jump to the right date.
async function navigateToDate(page, targetDate) {
  // Format: "Tue, Mar 17" — matches the date pill shown in the schedule header
  const targetStr = targetDate.toISOString().split('T')[0]; // YYYY-MM-DD for input

  // Click the calendar icon / date pill in the header
  const datePicker = page.locator('[aria-label*="date" i], button:has-text("Mar"), button:has-text("Jan"), button:has-text("Feb"), button:has-text("Apr"), button:has-text("May"), button:has-text("Jun"), button:has-text("Jul"), button:has-text("Aug"), button:has-text("Sep"), button:has-text("Oct"), button:has-text("Nov"), button:has-text("Dec")').first();

  try {
    await datePicker.waitFor({ timeout: 5000 });
    await datePicker.click();
    // If a date input appears, fill it
    const dateField = page.locator('input[type="date"]').first();
    if (await dateField.count() > 0) {
      await dateField.fill(targetStr);
      await dateField.press('Enter');
    }
  } catch {
    // If date picker doesn't respond, try clicking the calendar icon
    const calIcon = page.locator('svg[data-icon*="calendar"], button[aria-label*="calendar" i]').first();
    if (await calIcon.count() > 0) await calIcon.click();
  }

  await page.waitForTimeout(1000);
  console.log(`📆 Navigated to date: ${targetStr}`);
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

// Converts a JS Date to Playtomic's time format: "01:30 p.m."
function toPlaytomicTimeFormat(date) {
  let h = date.getHours();
  const m   = date.getMinutes();
  const mer = h >= 12 ? 'p.m.' : 'a.m.';
  if (h > 12) h -= 12;
  if (h === 0) h = 12;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} ${mer}`;
}

async function takeScreenshot(page, bookingId, label) {
  try {
    const path = `/tmp/screenshot-${bookingId}-${label}.png`;
    await page.screenshot({ path, fullPage: false });
    console.log(`📸 Screenshot: ${path}`);
  } catch (_) {}
}

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(CONFIG.PORT, () => {
  console.log(`🚀 Padel Junction Playtomic Blocker running on port ${CONFIG.PORT}`);
});
