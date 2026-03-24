/**
 * PADEL JUNCTION — PLAYTOMIC AUTO-BLOCKER
 * ----------------------------------------
 * Pure API — no Playwright, no browser.
 *
 * Auth strategy (fully tested live March 2026):
 *   On startup:  POST /api/v2/auth/token { grant_type: refresh_token, refresh_token }
 *   On 401:      same — force a fresh refresh
 *   After every successful refresh: update PLAYTOMIC_REFRESH_TOKEN in Railway via GraphQL
 *   so the env var stays perpetually fresh across restarts/deploys.
 *
 * Blocking (fully tested live March 2026):
 *   POST /api/v1/availability/availability_blocks
 *   { name, resource_ids[], start: UTC ISO, end: UTC ISO, tenant_id }
 */

require('dotenv').config();
const express = require('express');

const app = express();
app.use(express.json());

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  PORT:                    process.env.PORT || 3000,
  WEBHOOK_SECRET:          process.env.WEBHOOK_SECRET,
  PLAYTOMIC_TENANT_ID:     process.env.PLAYTOMIC_TENANT_ID,
  PLAYTOMIC_REFRESH_TOKEN: process.env.PLAYTOMIC_REFRESH_TOKEN,
  RAILWAY_API_TOKEN:       process.env.RAILWAY_API_TOKEN,
  RAILWAY_PROJECT_ID:      process.env.RAILWAY_PROJECT_ID      || 'e6770e59-9287-43ce-aa4b-157b28f6969c',
  RAILWAY_ENV_ID:          process.env.RAILWAY_ENV_ID          || '93deb196-c678-470d-b6fd-d1922153dc87',
  RAILWAY_SERVICE_ID:      process.env.RAILWAY_SERVICE_ID      || 'e7bca5d4-b55c-4802-b4b4-853c07c513e8',
};

const PLAYTOMIC_BASE = 'https://manager.playtomic.io';

const RESOURCE_IDS = {
  '1': '1f900b5d-f99d-4b17-9a8a-1ceb28be5299',
  '2': '6ea04658-e7db-456a-beef-efc9c91fa7b0',
};

let tokenState = {
  accessToken:           null,
  accessTokenExpiration: null,
  refreshToken:          CONFIG.PLAYTOMIC_REFRESH_TOKEN || null,
};

// ── RAILWAY ENV VAR UPDATE ────────────────────────────────────────────────────

async function persistRefreshTokenToRailway(newRefreshToken) {
  if (!CONFIG.RAILWAY_API_TOKEN) {
    console.log('⚠️  RAILWAY_API_TOKEN not set — token will not survive restarts');
    return;
  }
  try {
    const res = await fetch('https://backboard.railway.com/graphql/v2', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${CONFIG.RAILWAY_API_TOKEN}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        query: `mutation {
          variableUpsert(input: {
            projectId:     "${CONFIG.RAILWAY_PROJECT_ID}"
            environmentId: "${CONFIG.RAILWAY_ENV_ID}"
            serviceId:     "${CONFIG.RAILWAY_SERVICE_ID}"
            name:          "PLAYTOMIC_REFRESH_TOKEN"
            value:         "${newRefreshToken}"
          })
        }`
      }),
    });
    const data = await res.json();
    if (data?.data?.variableUpsert === true) {
      console.log('🔁 Refresh token persisted to Railway env var.');
    } else {
      console.error('⚠️  Railway env var update failed:', JSON.stringify(data));
    }
  } catch (e) {
    console.error('⚠️  Railway env var update error:', e.message);
  }
}

// ── TOKEN REFRESH ─────────────────────────────────────────────────────────────

async function refreshAccessToken() {
  if (!tokenState.refreshToken) {
    throw new Error('No refresh token. Set PLAYTOMIC_REFRESH_TOKEN in Railway env vars.');
  }
  console.log('🔄 Refreshing Playtomic access token...');
  const res = await fetch(`${PLAYTOMIC_BASE}/api/v2/auth/token`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ grant_type: 'refresh_token', refresh_token: tokenState.refreshToken }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed ${res.status}: ${text}`);
  }
  const data = await res.json();
  tokenState = {
    accessToken:           data.access_token,
    accessTokenExpiration: data.access_token_expiration,
    refreshToken:          data.refresh_token,
  };
  console.log(`✅ Token refreshed. Expires: ${tokenState.accessTokenExpiration}`);
  await persistRefreshTokenToRailway(data.refresh_token);
  return tokenState.accessToken;
}

async function getAccessToken() {
  if (tokenState.accessToken && tokenState.accessTokenExpiration) {
    const expiresAt = new Date(tokenState.accessTokenExpiration).getTime();
    if (Date.now() < expiresAt - 60_000) return tokenState.accessToken;
  }
  return refreshAccessToken();
}

// ── CREATE BLOCK ──────────────────────────────────────────────────────────────

async function createBlock(booking) {
  const courtNum   = (booking.court.match(/\d+/) || ['1'])[0];
  const resourceId = RESOURCE_IDS[courtNum];
  if (!resourceId) throw new Error(`Unknown court: ${booking.court}`);

  const payload = {
    name:         `CatchCorner – ${booking.customer || 'Booking'}`,
    resource_ids: [resourceId],
    start:        booking.startTime,
    end:          booking.endTime,
    tenant_id:    CONFIG.PLAYTOMIC_TENANT_ID,
  };

  console.log(`📡 Creating block: ${JSON.stringify(payload)}`);

  const token = await getAccessToken();
  const res = await fetch(`${PLAYTOMIC_BASE}/api/v1/availability/availability_blocks`, {
    method:  'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body:    JSON.stringify(payload),
  });

  const text = await res.text();
  console.log(`📡 Response ${res.status}: ${text.substring(0, 300)}`);

  if (res.status === 401) {
    console.log('🔄 401 — forcing token refresh and retrying...');
    tokenState.accessToken = null;
    const freshToken = await getAccessToken();
    const retry = await fetch(`${PLAYTOMIC_BASE}/api/v1/availability/availability_blocks`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${freshToken}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body:    JSON.stringify(payload),
    });
    const retryText = await retry.text();
    console.log(`📡 Retry ${retry.status}: ${retryText.substring(0, 300)}`);
    if (!retry.ok) throw new Error(`API ${retry.status}: ${retryText}`);
    return JSON.parse(retryText);
  }

  if (!res.ok) throw new Error(`API ${res.status}: ${text}`);
  return JSON.parse(text);
}

// ── HEALTH ────────────────────────────────────────────────────────────────────

app.get('/', (req, res) => res.json({
  status: 'ok', service: 'Padel Junction Playtomic Blocker',
  hasRefreshToken: !!tokenState.refreshToken,
  hasAccessToken:  !!tokenState.accessToken,
  tokenExpires:    tokenState.accessTokenExpiration || 'not yet fetched',
}));

// ── WEBHOOK ───────────────────────────────────────────────────────────────────

app.post('/webhook/catchcorner', async (req, res) => {
  const { secret, booking } = req.body;
  if (secret !== CONFIG.WEBHOOK_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  if (!booking?.startTime || !booking?.endTime || !booking?.court)
    return res.status(400).json({ error: 'Missing booking fields' });

  console.log(`📥 Booking: ${booking.court} @ ${booking.startTime} – ${booking.endTime}`);
  res.json({ status: 'accepted' });

  try {
    const result = await createBlock(booking);
    console.log(`✅ Block created: ${result.availability_block_id}`);
  } catch (err) {
    console.error(`❌ Block failed for ${booking.id}: ${err.message}`);
  }
});

// ── STARTUP ───────────────────────────────────────────────────────────────────

app.listen(CONFIG.PORT, async () => {
  console.log(`🚀 Padel Junction Playtomic Blocker on port ${CONFIG.PORT}`);
  console.log(`   Refresh token: ${tokenState.refreshToken ? '✅ loaded' : '❌ MISSING'}`);
  console.log(`   Railway token: ${CONFIG.RAILWAY_API_TOKEN ? '✅ loaded' : '⚠️  not set'}`);
  if (tokenState.refreshToken) {
    try {
      await refreshAccessToken();
      console.log('✅ Startup token refresh complete.');
    } catch (e) {
      console.error(`❌ Startup token refresh failed: ${e.message}`);
    }
  }
});
