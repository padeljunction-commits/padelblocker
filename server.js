require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const express = require('express');
const { chromium } = require('playwright-core');

const app = express();
app.use(express.json({ limit: '256kb' }));

const CONFIG = {
  PORT: Number(process.env.PORT || 3000),
  WEBHOOK_SECRET: process.env.WEBHOOK_SECRET,
  PLAYTOMIC_EMAIL: process.env.PLAYTOMIC_EMAIL,
  PLAYTOMIC_PASSWORD: process.env.PLAYTOMIC_PASSWORD,
  PLAYTOMIC_TENANT_ID: process.env.PLAYTOMIC_TENANT_ID,
  CHROMIUM_PATH: process.env.CHROMIUM_PATH || null,
  JOB_STORE_PATH: process.env.JOB_STORE_PATH || '/data/jobs.json',
  MAX_ATTEMPTS: Number(process.env.MAX_ATTEMPTS || 20),
};

const CLUB_TZ = 'America/Toronto';
const API_BASE = 'https://manager.playtomic.io/api/v1/availability/availability_blocks';
const RESOURCE_IDS = {
  '1': '1f900b5d-f99d-4b17-9a8a-1ceb28be5299',
  '2': '6ea04658-e7db-456a-beef-efc9c91fa7b0',
};

let cachedWriteToken = null;
let cachedWriteTokenExpiresAt = 0;
let persistentContextPromise = null;
let store = { version: 1, jobs: {} };
let storeWrite = Promise.resolve();
let workerStarted = false;

function requireSecret(req, res, next) {
  const supplied = req.get('x-webhook-secret') || req.body?.secret;
  if (!CONFIG.WEBHOOK_SECRET || supplied !== CONFIG.WEBHOOK_SECRET) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  next();
}

function validateBooking(booking) {
  if (!booking?.id || !booking?.startTime || !booking?.endTime || !booking?.court) {
    return 'Missing booking id, startTime, endTime, or court';
  }
  const start = new Date(booking.startTime);
  const end = new Date(booking.endTime);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) {
    return 'Invalid booking time range';
  }
  const courtNum = booking.court.match(/\d+/)?.[0];
  if (!RESOURCE_IDS[courtNum]) return `Unknown court: ${booking.court}`;
  return null;
}

function jobIdFor(booking) {
  return crypto.createHash('sha256')
    .update(`catchcorner:${booking.id}:${booking.court}:${booking.startTime}:${booking.endTime}`)
    .digest('hex')
    .slice(0, 24);
}

async function loadStore() {
  await fs.mkdir(path.dirname(CONFIG.JOB_STORE_PATH), { recursive: true });
  try {
    const parsed = JSON.parse(await fs.readFile(CONFIG.JOB_STORE_PATH, 'utf8'));
    if (parsed?.version === 1 && parsed.jobs && typeof parsed.jobs === 'object') store = parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    await saveStore();
  }

  const now = new Date().toISOString();
  for (const job of Object.values(store.jobs)) {
    if (job.status === 'processing') {
      job.status = 'queued';
      job.nextAttemptAt = now;
      job.lastError = 'Recovered after service restart';
    }
  }
  await saveStore();
}

function saveStore() {
  storeWrite = storeWrite.then(async () => {
    const temp = `${CONFIG.JOB_STORE_PATH}.tmp`;
    await fs.writeFile(temp, JSON.stringify(store, null, 2), 'utf8');
    await fs.rename(temp, CONFIG.JOB_STORE_PATH);
  });
  return storeWrite;
}

async function enqueueBooking(booking) {
  const id = jobIdFor(booking);
  const existing = store.jobs[id];
  if (existing) return { job: existing, duplicate: true };

  const now = new Date().toISOString();
  const job = {
    id,
    sourceId: String(booking.id),
    booking: {
      id: String(booking.id),
      court: String(booking.court),
      customer: String(booking.customer || 'Booking').slice(0, 180),
      startTime: new Date(booking.startTime).toISOString(),
      endTime: new Date(booking.endTime).toISOString(),
    },
    status: 'queued',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    nextAttemptAt: now,
    lastError: null,
    blockId: null,
    result: null,
  };
  store.jobs[id] = job;
  await saveStore();
  return { job, duplicate: false };
}

function publicJob(job) {
  return {
    id: job.id,
    sourceId: job.sourceId,
    status: job.status,
    attempts: job.attempts,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    nextAttemptAt: job.nextAttemptAt,
    lastError: job.lastError,
    blockId: job.blockId,
    booking: job.booking,
  };
}

app.get('/', (req, res) => {
  const jobs = Object.values(store.jobs);
  res.json({
    status: 'ok',
    service: 'Padel Junction Playtomic Blocker',
    durableQueue: true,
    hasWriteToken: hasUsableWriteToken(),
    jobs: {
      queued: jobs.filter(j => j.status === 'queued').length,
      processing: jobs.filter(j => j.status === 'processing').length,
      succeeded: jobs.filter(j => j.status === 'succeeded').length,
      failed: jobs.filter(j => j.status === 'failed').length,
    },
  });
});

app.post('/webhook/catchcorner', requireSecret, async (req, res) => {
  const error = validateBooking(req.body.booking);
  if (error) return res.status(400).json({ error });

  try {
    const { job, duplicate } = await enqueueBooking(req.body.booking);
    console.log(`QUEUE ${duplicate ? 'duplicate' : 'accepted'} job=${job.id} source=${job.sourceId}`);
    res.status(202).json({ status: duplicate ? job.status : 'queued', duplicate, jobId: job.id });
  } catch (err) {
    console.error(`QUEUE persist failed: ${err.message}`);
    res.status(503).json({ error: 'Unable to persist booking job' });
  }
});

app.get('/admin/jobs', requireSecret, (req, res) => {
  const jobs = Object.values(store.jobs)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 200)
    .map(publicJob);
  res.json({ jobs });
});

app.get('/admin/jobs/:id', requireSecret, (req, res) => {
  const job = store.jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(publicJob(job));
});

app.post('/admin/jobs/:id/retry', requireSecret, async (req, res) => {
  const job = store.jobs[req.params.id];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status === 'succeeded') return res.status(409).json({ error: 'Job already succeeded' });
  job.status = 'queued';
  job.nextAttemptAt = new Date().toISOString();
  job.updatedAt = new Date().toISOString();
  await saveStore();
  res.json(publicJob(job));
});

app.post('/admin/blocks/:id/delete', requireSecret, async (req, res) => {
  try {
    const result = await deleteBlockViaAPI(req.params.id);
    res.json({ status: 'deleted', blockId: req.params.id, result });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/admin/blocks/:id', requireSecret, async (req, res) => {
  try {
    const result = await getBlockViaAPI(req.params.id);
    res.json({ status: 'present', blockId: req.params.id, result });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

function nextRunnableJob() {
  const now = Date.now();
  return Object.values(store.jobs)
    .filter(j => j.status === 'queued' && new Date(j.nextAttemptAt).getTime() <= now)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] || null;
}

async function runWorker() {
  if (workerStarted) return;
  workerStarted = true;
  console.log(`WORKER started store=${CONFIG.JOB_STORE_PATH}`);
  while (true) {
    const job = nextRunnableJob();
    if (!job) {
      await delay(1000);
      continue;
    }
    await processJob(job);
  }
}

async function processJob(job) {
  job.status = 'processing';
  job.attempts += 1;
  job.updatedAt = new Date().toISOString();
  await saveStore();
  console.log(`JOB start id=${job.id} source=${job.sourceId} attempt=${job.attempts}`);

  try {
    const result = await createBlockReliable(job.booking);
    job.status = 'succeeded';
    job.result = sanitizeResult(result);
    job.blockId = extractBlockId(result);
    job.lastError = null;
    job.nextAttemptAt = null;
    console.log(`JOB success id=${job.id} block=${job.blockId || 'unknown'}`);
  } catch (err) {
    job.lastError = String(err.message || err).slice(0, 1500);
    job.status = job.attempts >= CONFIG.MAX_ATTEMPTS ? 'failed' : 'queued';
    const backoffMinutes = Math.min(30, Math.max(1, 2 ** Math.min(job.attempts - 1, 5)));
    job.nextAttemptAt = new Date(Date.now() + backoffMinutes * 60_000).toISOString();
    console.error(`JOB failure id=${job.id} attempt=${job.attempts} next=${job.nextAttemptAt} error=${job.lastError}`);
  }
  job.updatedAt = new Date().toISOString();
  await saveStore();
}

async function createBlockReliable(booking) {
  if (hasUsableWriteToken()) {
    try {
      return await blockViaAPI(booking);
    } catch (err) {
      if (!isAuthFailure(err)) throw err;
      console.warn('AUTH cached write token rejected; falling back to Playtomic UI');
      clearWriteToken();
    }
  }
  return blockViaBrowser(booking);
}

function isAuthFailure(err) {
  return /API (401|403)\b/.test(String(err?.message || err));
}

function hasUsableWriteToken() {
  return Boolean(cachedWriteToken && cachedWriteTokenExpiresAt > Date.now() + 60_000);
}

function clearWriteToken() {
  cachedWriteToken = null;
  cachedWriteTokenExpiresAt = 0;
}

function cacheWriteToken(authHeader) {
  if (!authHeader?.startsWith('Bearer ')) return;
  cachedWriteToken = authHeader.slice('Bearer '.length);
  cachedWriteTokenExpiresAt = tokenExpiry(cachedWriteToken) || Date.now() + 50 * 60_000;
  console.log(`AUTH captured token from successful availability-block POST exp=${new Date(cachedWriteTokenExpiresAt).toISOString()}`);
}

function tokenExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload.exp ? payload.exp * 1000 : 0;
  } catch (_) {
    return 0;
  }
}

function blockPayload(booking) {
  const courtNum = booking.court.match(/\d+/)?.[0];
  return {
    tenant_id: CONFIG.PLAYTOMIC_TENANT_ID,
    resource_ids: [RESOURCE_IDS[courtNum]],
    name: `CatchCorner - ${booking.customer || 'Booking'}`,
    start: new Date(booking.startTime).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    end: new Date(booking.endTime).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

async function blockViaAPI(booking) {
  const payload = blockPayload(booking);
  console.log(`API create court=${booking.court} start=${payload.start} end=${payload.end}`);
  const res = await fetchWithTimeout(API_BASE, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(payload),
  });
  const body = await readResponse(res);
  if (!res.ok) throw new Error(`API ${res.status}: ${stringifyBody(body)}`);
  return body;
}

async function getBlockViaAPI(blockId) {
  if (!hasUsableWriteToken()) throw new Error('No usable write token; create a block through the worker first');
  const res = await fetchWithTimeout(`${API_BASE}/${encodeURIComponent(blockId)}`, {
    method: 'GET', headers: authHeaders(),
  });
  const body = await readResponse(res);
  if (!res.ok) throw new Error(`API ${res.status}: ${stringifyBody(body)}`);
  return body;
}

async function deleteBlockViaAPI(blockId) {
  if (!hasUsableWriteToken()) throw new Error('No usable write token; create a block through the worker first');
  const res = await fetchWithTimeout(`${API_BASE}/${encodeURIComponent(blockId)}`, {
    method: 'DELETE', headers: authHeaders(),
  });
  const body = await readResponse(res);
  if (!res.ok) throw new Error(`API ${res.status}: ${stringifyBody(body)}`);
  return body;
}

function authHeaders() {
  return {
    Authorization: `Bearer ${cachedWriteToken}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function readResponse(res) {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return text.slice(0, 1000); }
}

function stringifyBody(body) {
  return typeof body === 'string' ? body : JSON.stringify(body);
}

function sanitizeResult(result) {
  if (result == null) return null;
  return JSON.parse(JSON.stringify(result));
}

function extractBlockId(result) {
  return result?.availability_block_id || result?.availabilityBlockId || result?.id ||
    result?.availability_block?.id || result?.data?.id || null;
}

async function blockViaBrowser(booking) {
  const context = await getPersistentContext();
  const page = await context.newPage();

  try {
    const start = new Date(booking.startTime);
    const end = new Date(booking.endTime);
    const courtNum = booking.court.match(/\d+/)?.[0];
    const dateStr = toDateStr(start);
    const [targetYear, targetMonth, targetDay] = dateStr.split('-').map(Number);

    const formUrl = `https://manager.playtomic.io/dashboard/schedule/add/block?tid=${CONFIG.PLAYTOMIC_TENANT_ID}`;
    await page.goto(formUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (page.url().includes('/auth/login')) {
      console.log('UI persistent session requires login');
      await page.getByRole('textbox', { name: 'Email' }).fill(CONFIG.PLAYTOMIC_EMAIL);
      await page.getByRole('textbox', { name: 'Password' }).fill(CONFIG.PLAYTOMIC_PASSWORD);
      await page.getByRole('button', { name: 'Log In' }).click();
      await page.waitForFunction(() => !window.location.pathname.includes('/auth/login'), { timeout: 45_000 });
      await page.goto(formUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    } else {
      console.log('UI reusing persistent Playtomic session');
    }
    await page.locator('#input-resource').waitFor({ timeout: 20_000 });

    await setReactInput(page, 'input-name', `CatchCorner - ${booking.customer || 'Booking'}`);
    await selectDate(page, targetYear, targetMonth, targetDay);
    await selectDropdown(page, 'input-resource', `Padel ${courtNum}`, `Padel ${courtNum}`);
    await selectDropdown(page, 'input-startTime', toTypeStr(start), toDisplayTime(start));
    await selectDropdown(page, 'input-endTime', toTypeStr(end), toDisplayTime(end));

    const responsePromise = page.waitForResponse(
      response => response.request().method() === 'POST' && response.url().includes('/availability/availability_blocks'),
      { timeout: 30_000 },
    );

    await page.evaluate(() => {
      const resourceInput = document.getElementById('input-resource');
      if (!resourceInput) throw new Error('#input-resource missing at submit');
      let container = resourceInput.parentElement;
      for (let depth = 0; depth < 10 && container; depth += 1, container = container.parentElement) {
        const buttons = Array.from(container.querySelectorAll('button')).filter(button =>
          button.offsetParent && button.textContent.trim() === 'Create' && !button.disabled,
        );
        if (buttons.length === 1) {
          buttons[0].click();
          return;
        }
      }
      throw new Error('Form-scoped enabled Create button not found');
    });

    const response = await responsePromise;
    const responseBody = await readPlaywrightResponse(response);
    if (!response.ok()) throw new Error(`UI create API ${response.status()}: ${stringifyBody(responseBody)}`);

    cacheWriteToken(response.request().headers().authorization);
    console.log(`UI create succeeded status=${response.status()} block=${extractBlockId(responseBody) || 'unknown'}`);
    return responseBody;
  } catch (err) {
    console.error(`UI failure url=${page.url()} error=${err.message}`);
    throw err;
  } finally {
    await page.close();
  }
}

async function getPersistentContext() {
  if (!persistentContextPromise) {
    const profilePath = path.join(path.dirname(CONFIG.JOB_STORE_PATH), 'playtomic-profile');
    persistentContextPromise = chromium.launchPersistentContext(profilePath, {
      headless: true,
      viewport: { width: 1280, height: 900 },
      locale: 'en-CA',
      timezoneId: CLUB_TZ,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      ...(CONFIG.CHROMIUM_PATH ? { executablePath: CONFIG.CHROMIUM_PATH } : {}),
    }).catch(err => {
      persistentContextPromise = null;
      throw err;
    });
  }
  return persistentContextPromise;
}

async function readPlaywrightResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch (_) { return text.slice(0, 1000); }
}

async function setReactInput(page, id, value) {
  await page.evaluate(({ id, value }) => {
    const input = document.getElementById(id);
    if (!input) throw new Error(`#${id} not found`);
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, { id, value });
}

async function selectDate(page, year, month, day) {
  await page.locator('#input-startDate').click();
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];

  for (let attempt = 0; attempt < 36; attempt += 1) {
    const current = await page.evaluate((monthNames) => {
      const visibleLeaves = Array.from(document.querySelectorAll('*'))
        .filter(el => el.offsetParent && el.children.length === 0);
      const monthEl = visibleLeaves.find(el => monthNames.includes(el.textContent.trim()));
      const yearEl = visibleLeaves.find(el => /^\d{4}$/.test(el.textContent.trim()));
      return {
        month: monthEl ? monthNames.indexOf(monthEl.textContent.trim()) + 1 : null,
        year: yearEl ? Number(yearEl.textContent.trim()) : null,
      };
    }, months);
    if (current.month === month && current.year === year) break;
    if (!current.month || !current.year) throw new Error('Calendar month/year not found');
    const goNext = (year - current.year) * 12 + (month - current.month) > 0;
    await page.evaluate(({ goNext, months }) => {
      const leaves = Array.from(document.querySelectorAll('*')).filter(el => el.offsetParent && el.children.length === 0);
      const monthEl = leaves.find(el => months.includes(el.textContent.trim()));
      let container = monthEl?.parentElement;
      for (let depth = 0; depth < 6 && container; depth += 1, container = container.parentElement) {
        const wanted = goNext ? 'next' : 'previous';
        const buttons = Array.from(container.querySelectorAll('button')).filter(button => {
          if (!button.offsetParent || button.disabled) return false;
          const label = String(button.getAttribute('aria-label') || button.getAttribute('title') || '')
            .trim().toLowerCase();
          return label === wanted || label.startsWith(`${wanted} `);
        });
        if (buttons.length === 1) {
          buttons[0].click();
          return;
        }
      }
      throw new Error(`Calendar ${goNext ? 'Next' : 'Previous'} button not found near ${monthEl?.textContent || 'month'}`);
    }, { goNext, months });
    await delay(150);
  }

  await page.evaluate(({ year, month, day, monthName }) => {
    const visibleButtons = Array.from(document.querySelectorAll('button'))
      .filter(button => button.offsetParent && !button.disabled);
    const normalized = value => String(value || '').toLowerCase().replace(/[,.-]/g, ' ').replace(/\s+/g, ' ').trim();
    const fullDateTokens = [String(year), monthName.toLowerCase(), String(day)];

    // Playtomic has used several calendar implementations. Prefer a button
    // whose accessible date contains the full target date, then fall back to
    // the visible day number after the picker has been moved to the right month.
    let button = visibleButtons.find(candidate => {
      const metadata = normalized([
        candidate.getAttribute('aria-label'),
        candidate.getAttribute('title'),
        candidate.getAttribute('data-date'),
        candidate.getAttribute('datetime'),
      ].join(' '));
      return fullDateTokens.every(token => metadata.includes(token));
    });

    if (!button) {
      const dayCandidates = visibleButtons.filter(candidate => candidate.textContent.trim() === String(day));
      button = dayCandidates.find(candidate => {
        const classes = normalized(candidate.className);
        return !classes.includes('outside') && !classes.includes('neighbor') && !classes.includes('overflow');
      }) || dayCandidates[0];
    }

    if (!button) {
      const sample = visibleButtons
        .map(candidate => `${candidate.textContent.trim()}[${candidate.getAttribute('aria-label') || ''}]`)
        .filter(Boolean)
        .slice(0, 80)
        .join('|');
      throw new Error(`Calendar date ${year}-${month}-${day} not found; buttons=${sample}`);
    }
    button.click();
  }, { year, month, day, monthName: months[month - 1] });
}

async function selectDropdown(page, inputId, filterText, optionText) {
  await page.evaluate((id) => {
    const input = document.getElementById(id);
    if (!input) throw new Error(`#${id} not found`);
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', keyCode: 32, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', keyCode: 32, bubbles: true }));
  }, inputId);
  await setReactInput(page, inputId, filterText);
  await page.evaluate((wanted) => {
    const normalize = value => value.trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ');
    const options = Array.from(document.querySelectorAll('.select__option')).filter(el => el.offsetParent);
    const target = options.find(el => normalize(el.textContent) === normalize(wanted));
    if (!target) throw new Error(`Option ${wanted} not found; available=${options.map(el => el.textContent.trim()).join('|')}`);
    target.click();
  }, optionText);
}

function toDateStr(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CLUB_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = type => parts.find(part => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function localTimeParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CLUB_TZ, hour12: false, hour: '2-digit', minute: '2-digit',
  }).formatToParts(date);
  return {
    hour: Number(parts.find(part => part.type === 'hour')?.value),
    minute: Number(parts.find(part => part.type === 'minute')?.value),
  };
}

function toTypeStr(date) {
  let { hour, minute } = localTimeParts(date);
  if (hour > 12) hour -= 12;
  if (hour === 0 || hour === 24) hour = 12;
  return `${hour}:${String(minute).padStart(2, '0')}`;
}

function toDisplayTime(date) {
  let { hour, minute } = localTimeParts(date);
  const meridiem = hour >= 12 && hour < 24 ? 'p.m.' : 'a.m.';
  if (hour > 12) hour -= 12;
  if (hour === 0 || hour === 24) hour = 12;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')} ${meridiem}`;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function start() {
  for (const [name, value] of Object.entries({
    WEBHOOK_SECRET: CONFIG.WEBHOOK_SECRET,
    PLAYTOMIC_EMAIL: CONFIG.PLAYTOMIC_EMAIL,
    PLAYTOMIC_PASSWORD: CONFIG.PLAYTOMIC_PASSWORD,
    PLAYTOMIC_TENANT_ID: CONFIG.PLAYTOMIC_TENANT_ID,
  })) {
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
  }
  await loadStore();
  app.listen(CONFIG.PORT, () => console.log(`SERVICE listening port=${CONFIG.PORT}`));
  runWorker().catch(err => {
    console.error(`WORKER fatal: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}

if (require.main === module) {
  start().catch(err => {
    console.error(`STARTUP fatal: ${err.stack || err.message}`);
    process.exit(1);
  });
}

module.exports = {
  app,
  blockPayload,
  extractBlockId,
  jobIdFor,
  toDateStr,
  toDisplayTime,
  toTypeStr,
  validateBooking,
};
