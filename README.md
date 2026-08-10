# Padel Junction Playtomic blocker

Receives CatchCorner booking events from Google Apps Script and creates matching
Playtomic availability blocks. This service does not participate in the
Playtomic-to-Google-Calendar sync.

## Reliability model

- A webhook is acknowledged only after its job is written to `/data/jobs.json`.
- `/data` is a Railway persistent volume, so jobs survive deployments/restarts.
- The worker is serialized to prevent simultaneous Playtomic login/token races.
- Job identity includes source event ID, court, start, and end; identical webhook
  deliveries do not create duplicate blocks.
- Failed jobs retry with exponential backoff and remain inspectable.
- A persistent Playwright profile is stored under `/data/playtomic-profile`.
- The first UI-created block captures the authorization header from Playtomic's
  own successful availability-block POST. Subsequent jobs use the fast API path.
- A 401 or 403 clears the cached write token and falls back to the manager UI.

## Required Railway variables

- `WEBHOOK_SECRET`
- `PLAYTOMIC_EMAIL`
- `PLAYTOMIC_PASSWORD`
- `PLAYTOMIC_TENANT_ID`
- `JOB_STORE_PATH=/data/jobs.json` (optional; this is the default)
- `MAX_ATTEMPTS=20` (optional; this is the default)

Do not commit any of these values.

## Endpoints

- `POST /webhook/catchcorner` queues a booking and returns HTTP 202.
- `GET /` reports service and queue health.
- `GET /admin/jobs` lists recent jobs.
- `GET /admin/jobs/:id` shows one job.
- `POST /admin/jobs/:id/retry` retries an unsuccessful job immediately.
- `GET /admin/blocks/:id` verifies a Playtomic block by ID.
- `POST /admin/blocks/:id/delete` idempotently deletes a block and marks its job
  deleted.

Admin endpoints require `x-webhook-secret`. The webhook accepts the existing
`secret` request-body field for compatibility with Google Apps Script.

## Local validation

```powershell
npm.cmd install
npm.cmd test
```

The unit suite covers booking validation, idempotency keys, UTC API payloads,
Toronto/September UI times, and known Playtomic response ID shapes.

## Production test completed 2026-08-10

Three September blocks were created, fetched by ID to verify court and exact
times, then deleted and fetched again to confirm absence:

- Court 1: September 22, 10:15-11:15 AM Toronto time
- Court 2: September 23, 12:00-1:30 PM Toronto time
- Court 1: September 24, 8:45-9:45 PM Toronto time

An identical replay of the second webhook returned the existing succeeded job
and did not create another Playtomic block.
