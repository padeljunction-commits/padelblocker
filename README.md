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
- The worker can refresh an authenticated session by opening the existing manager
  form without submitting a block. A successful UI-created block also captures
  its authorization header. Subsequent jobs use the fast API path.
- A 401 or 403 clears the cached write token and falls back to the manager UI.

## Required Railway variables

- `WEBHOOK_SECRET`
- `PLAYTOMIC_EMAIL`
- `PLAYTOMIC_PASSWORD`
- `PLAYTOMIC_TENANT_ID`
- `JOB_STORE_PATH=/data/jobs.json` (optional; this is the default)
- `MAX_ATTEMPTS=20` (optional; this is the default)
- `BOOKING_CALENDAR_IDS` (required for revision sync): the existing Court 1 and
  Court 2 calendar IDs, comma-separated in that order. Legacy delivery continues
  without this variable; revision endpoints fail closed until it is configured.

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
- `POST /sync/calendar/preview` validates a complete calendar snapshot and reports
  planned changes against an isolated state copy, without persisting or writing blocks.
- `POST /sync/calendar` durably accepts a complete two-court snapshot.
- `GET /admin/sync` reports desired revisions, owned blocks, issues, and historical drift.
- `POST /admin/sync/control` with `{"paused":true}` pauses revision processing;
  false resumes it. The setting is durable and is visible in health/status.
- `POST /admin/sync/:key/recover` accepts a manually identified `blockId` only if
  its persisted name, resource and times match a saved uncertain create intent.
- `POST /admin/sync/:key/retire` is explicit operator cleanup: it requires a fresh
  complete snapshot proving the source is absent, then verifies ownership before
  deleting and independently verifying removal of each remaining owned block.

Admin endpoints require `x-webhook-secret`. The webhook accepts the existing
`secret` request-body field for compatibility with Google Apps Script.

## Local validation

```powershell
npm.cmd install
npm.cmd test
```

The suite also covers reschedules, same-court overlaps, court changes, repeated
delivery, rapid A/B/C revisions, failure/restart checkpoints, uncertain writes,
ownership checks, incomplete/stale scans, existing paid reservations, legacy
adoption, explicit cleanup, and the authenticated HTTP persistence interface.

## Revision synchronization rollout

The implementation is gated and requires live verification before activation.

1. Configure `BOOKING_CALENDAR_IDS` using the existing source-script constants.
   Deploy this worker's exact tested revision; confirm `/` reports revision
   protocol version 1 and `configured: true`. Preserve the `/data` volume and
   existing credentials. The old webhook remains compatible.
2. In the **live** Padel Apps Script `Code.gs`, rename only the existing definition
   `watchCalendarForNonPlaytomic` to `watchCalendarForNonPlaytomicLegacy_`.
   Add the versioned `booking-revision-sync.gs` as a separate Script file. Do not
   upload a local replacement for the shared Code.gs. Preserve configuration,
   all unrelated code, and the three existing triggers.
3. Keep `PLAYTOMIC_REVISION_SYNC_ENABLED` absent/false initially. The new public
   handler dispatches to the existing implementation until explicitly enabled.
4. Run `previewBookingRevisionSync` and review its read-only migration report.
   Check duplicate source identities, uncertain legacy attempts, paid conflicts,
   and all proposed creates/replacements before activation.
5. Enable `PLAYTOMIC_REVISION_SYNC_ENABLED=true` in Script Properties. Run and
   inspect a full scan, actual destination state, current issues, and the
   unchanged triggers. Legacy IDs are adopted, not indiscriminately recreated.
6. Exercise September **future-year** test events through the real calendar path:
   original creation; date/time reschedule; partially overlapping time change;
   different court; and rapid consecutive revisions. Read back every current
   block and confirm the previous block IDs are absent. Test read-only preview
   and actual alert/recovery behavior. Never use the current week.
7. Delete test calendar events, perform a fresh complete scan, and use explicit
   authenticated retirement for only those test source keys. Verify every test
   block is absent and every test source retired. Retain audit history.

The worker stores full source identities (and CatchCorner booking numbers),
desired court/start/end, and replacement checkpoints in the existing durable
store. It verifies the replacement before deleting obsolete blocks and verifies
each obsolete block's current name/resource/times before deletion. Unknown or
edited blocks are held for review. If a write may have reached Playtomic without
a saved ID, it stops blind retries and exposes a recovery intent and alert.

Missing sources are flagged after repeated complete scans; they are **not**
automatically cancelled. Past reschedule differences are audit-only. Source
conflicts or recurring-instance ambiguities are held for review. No customer
Playtomic reservation is cancelled automatically. A paid reservation visible in
the calendar prevents replacement. The five-minute calendar poll still leaves a
cross-platform exposure window; this is not an atomic booking transaction.

Ongoing destination checks run approximately every 30 minutes for unchanged
managed bookings. The actual court/time is checked on every new write and before
every cleanup step. Source-driven processing pauses if the last complete scan
is over 20 minutes old. Owner alerts are deduplicated and repeated after six
hours while unresolved, with recovery notification when active issues clear.

Emergency stop: POST `{"paused":true}` to `/admin/sync/control`, confirm the
acknowledgement, then set the Script Property false and inspect pending
replacements and cleanup states. An in-flight create may finish and be recorded;
the worker holds cleanup while paused. Existing blocks are retained. Resume only
after posting a fresh full snapshot. Do not downgrade the worker
while a replacement or uncertain write is unresolved. A source explicitly
retired by an operator requires review if it subsequently reappears.

## Production test completed 2026-08-10

Three September blocks were created, fetched by ID to verify court and exact
times, then deleted and fetched again to confirm absence:

- Court 1: September 22, 10:15-11:15 AM Toronto time
- Court 2: September 23, 12:00-1:30 PM Toronto time
- Court 1: September 24, 8:45-9:45 PM Toronto time

An identical replay of the second webhook returned the existing succeeded job
and did not create another Playtomic block.
