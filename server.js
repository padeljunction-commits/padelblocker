/**
 * PADEL JUNCTION — PLAYTOMIC AUTO-BLOCKER
 * ----------------------------------------
 * Pure API implementation — no Playwright, no Chromium, no browser.
 *
 * Auth flow (fully tested live March 2026):
 *   POST /api/v2/auth/token { grant_type: 'refresh_token', refresh_token }
 *   → { access_token, refresh_token, access_token_expiration, ... }
 *   Tokens rotate on every refresh — new refresh_token saved back to disk.
 *
 * Blocking flow (fully tested live March 2026):
 *   POST /api/v1/availability/availability_blocks
 *   { name, resource_ids: [...], start: <UTC ISO>, end: <UTC ISO>, tenant_id }
 *   start/end are UTC ISO strings — exactly what CatchCorner sends. No conversion needed.
 *
 * Token persistence:
 *   Stored in /tmp/playtomic_tokens.json so Railway restarts don't force re-auth.
 *   Refresh token rotates — file is updated after every successful refresh.
 */

require('dotenv').config();
const express = require('express');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(express.json());

const CONFIG = {
  PORT:                process.env.PORT || 3000,
  WEBHOOK_SECRET:      process.env.WEBHOOK_SECRET,
  PLAYTOMIC_TENANT_ID: process.env.PLAYTOMIC_TENANT_ID,
  // Seeded once manually via Railway env var, then managed via TOKEN_FILE rotation
  PLAYTOMIC_REFRESH_TOKEN: process.env.PLAYTOMIC_REFRESH_TOKEN,
};

const PLAYTOMIC_BASE  = 'https://manager.playtomic.io';
const TOKEN_FILE      = '/tmp/playtomic_tokens.json';

// Court resource IDs (verified live)
const RESOURCE_IDS = {
  '1': '1f900b5d-f99d-4b17-9a8a-1ceb28be5299',
  '2': '6ea04658-e7db-456a-beef-efc9c91fa7b0',
};

// In-memory token state — loaded from disk on startup
let tokenState = {
  accessToken:           null,
  accessTokenExpiration: null,
  refreshToken:          CONFIG.PLAYTOMIC_REFRESH_TOKEN || null,
};

// ── TOKEN PERSISTENCE ─────────────────────────────────────────────────────────

function loadTokens() {
  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (data.refreshToken) {
      tokenState = data;
      console.log('🔑 Loaded tokens from disk. Access token expires:', data.accessTokenExpiration);
    }
  } catch (_) {
    console.log('📂 No token file found — will use PLAYTOMIC_REFRESH_TOKEN env var on first auth.');
  }
}

function saveTokens() {
  try {
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(tokenState, null, 2));
  } catch (e) {
    console.error('⚠️  Could not save tokens to disk:', e.message);
  }
}

// ── AUTH ──────────────────────────────────────────────────────────────────────

async function refreshAccessToken() {
  const refreshToken = tokenState.refreshToken;
  if (!refreshToken) throw new Error('No refresh token available. Set PLAYTOMIC_REFRESH_TOKEN in Railway env vars.');

  console.log('🔄 Refreshing Playtomic access token...');

  const res = await fetch(`${PLAYTOMIC_BASE}/api/v2/auth/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed ${res.status}: ${text}`);
  }

  const data = await res.json();

  // Tokens rotate on every refresh — must save the new refresh_token
  tokenState = {
    accessToken:            data.access_token,
    accessTokenExpiration:  data.access_token_expiration,
    refreshToken:           data.refresh_token,  // rotated — save it
  };

  saveTokens();
  console.log(`✅ Token refreshed. Expires: ${tokenState.accessTokenExpiration}`);
  return tokenState.accessToken;
}

async function getAccessToken() {
  // Use cached token if it's still valid (with 60s buffer)
  if (tokenState.accessToken && tokenState.accessTokenExpiration) {
    const expiresAt = new Date(tokenState.accessTokenExpiration).getTime();
    if (Date.now() < expiresAt - 60_000) {
      return tokenState.accessToken;
    }
  }
  return refreshAccessToken();
}

// ── BLOCK ─────────────────────────────────────────────────────────────────────

async function createBlock(booking) {
  const courtNum   = (booking.court.match(/\d+/) || ['1'])[0];
  const resourceId = RESOURCE_IDS[courtNum];
  if (!resourceId) throw new Error(`Unknown court: ${booking.court}`);

  const payload = {
    name:        `CatchCorner – ${booking.customer || 'Booking'}`,
    resource_ids: [resourceId],
    start:        booking.startTime,   // already UTC ISO from CatchCorner — use as-is
    end:          booking.endTime,
    tenant_id:    CONFIG.PLAYTOMIC_TENANT_ID,
  };

  console.log(`📡 Creating block: ${JSON.stringify(payload)}`);

  const token = await getAccessToken();

  const res = await fetch(`${PLAYTOMIC_BASE}/api/v1/availability/availability_blocks`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  console.log(`📡 Response ${res.status}: ${text.substring(0, 300)}`);

  // If token expired mid-flight, refresh once and retry
  if (res.status === 401) {
    console.log('🔄 401 — forcing token refresh and retrying...');
    tokenState.accessToken = null; // force refresh
    const freshToken = await getAccessToken();

    const retry = await fetch(`${PLAYTOMIC_BASE}/api/v1/availability/availability_blocks`, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${freshToken}`,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
      },
      body: JSON.stringify(payload),
    });

    const retryText = await retry.text();
    console.log(`📡 Retry response ${retry.status}: ${retryText.substring(0, 300)}`);
    if (!retry.ok) throw new Error(`API ${retry.status}: ${retryText}`);
    return JSON.parse(retryText);
  }

  if (!res.ok) throw new Error(`API ${res.status}: ${text}`);
  return JSON.parse(text);
}

// ── HEALTH ────────────────────────────────────────────────────────────────────

app.get('/', (req, res) =>
  res.json({
    status:           'ok',
    service:          'Padel Junction Playtomic Blocker',
    hasRefreshToken:  !!tokenState.refreshToken,
    hasAccessToken:   !!tokenState.accessToken,
    tokenExpires:     tokenState.accessTokenExpiration || 'not yet fetched',
  })
);

// ── WEBHOOK ───────────────────────────────────────────────────────────────────

app.post('/webhook/catchcorner', async (req, res) => {
  const { secret, booking } = req.body;

  if (secret !== CONFIG.WEBHOOK_SECRET)
    return res.status(403).json({ error: 'Unauthorized' });

  if (!booking?.startTime || !booking?.endTime || !booking?.court)
    return res.status(400).json({ error: 'Missing booking fields: startTime, endTime, court required' });

  console.log(`📥 Booking received: ${booking.court} @ ${booking.startTime} – ${booking.endTime}`);

  // Respond immediately — don't make CatchCorner wait on Playtomic API
  res.json({ status: 'accepted' });

  try {
    const result = await createBlock(booking);
    console.log(`✅ Block created: ${result.availability_block_id}`);
  } catch (err) {
    console.error(`❌ Block failed for booking ${booking.id}: ${err.message}`);
  }
});

// ── STARTUP ───────────────────────────────────────────────────────────────────

loadTokens();

app.listen(CONFIG.PORT, () => {
  console.log(`🚀 Padel Junction Playtomic Blocker running on port ${CONFIG.PORT}`);
  console.log(`   Refresh token: ${tokenState.refreshToken ? '✅ loaded' : '❌ MISSING — set PLAYTOMIC_REFRESH_TOKEN'}`);
});
