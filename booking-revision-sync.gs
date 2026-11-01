// Revision-aware booking sync. The existing handler remains the default until
// the worker is deployed and PLAYTOMIC_REVISION_SYNC_ENABLED is explicitly true.
function watchCalendarForNonPlaytomic() {
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('PLAYTOMIC_REVISION_SYNC_ENABLED') !== 'true') {
    return watchCalendarForNonPlaytomicLegacy_();
  }
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) {
    Logger.log('Booking revision scan skipped: another shared-script run is active');
    return;
  }
  let heartbeat = null;
  try {
    const snapshot = collectBookingCalendarSnapshot_();
    const response = postCalendarSnapshot_(snapshot);
    if (response.accepted === false && !response.stale) throw new Error('Worker did not durably accept the calendar snapshot');
    const report = checkCalendarSyncAlerts_() || {};
    const counts = report.counts || {};
    heartbeat = {
      scannedEvents: snapshot.events.length + snapshot.reservations.length,
      pendingEvents: ['pending', 'creating', 'cleanup', 'conflict', 'review', 'missing', 'source_conflict']
        .reduce((total, status) => total + Number(counts[status] || 0), 0),
    };
    if (props.getProperty('BOOKING_SYNC_SCAN_ERROR_AT')) {
      GmailApp.sendEmail(BLOCKER_ALERT_EMAIL, 'RECOVERED: BOOKING CALENDAR SYNC',
        'The calendar revision scan and durable Railway delivery have recovered. Any remaining booking issues have separate alerts.');
      props.deleteProperty('BOOKING_SYNC_SCAN_ERROR_AT');
    }
    Logger.log('Booking revision snapshot accepted: ' + snapshot.events.length + ' external events; ' + snapshot.reservations.length + ' Playtomic reservations');
  } catch (error) {
    Logger.log('Booking revision scan failed: ' + error.message);
    const alertedAt = props.getProperty('BOOKING_SYNC_SCAN_ERROR_AT');
    if (!alertedAt || Date.now() - new Date(alertedAt).getTime() >= 6 * 60 * 60 * 1000) {
      GmailApp.sendEmail(BLOCKER_ALERT_EMAIL, 'ALERT: BOOKING CALENDAR SYNC FAILED',
        'The automation could not complete a full calendar scan and reconciliation. Existing Playtomic blocks were retained.\n\n' +
        String(error.message).slice(0, 1500) + '\n\nThe next scheduled run will retry. Review imminent bookings manually.');
      props.setProperty('BOOKING_SYNC_SCAN_ERROR_AT', new Date().toISOString());
    }
  } finally { lock.releaseLock(); }
  // The existing monitor acquires the same lock, so call it after release.
  safelyMonitorRailwayFailedJobs_();
  if (heartbeat) sendBookingWatcherHeartbeat_(heartbeat);
}

function collectBookingCalendarSnapshot_() {
  const now = new Date();
  const windowStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const windowEnd = new Date(now.getTime() + WEBHOOK_HORIZON_DAYS * 24 * 60 * 60 * 1000);
  const calendars = [COURT1_CAL_ID, COURT2_CAL_ID];
  const events = [];
  const reservations = [];
  calendars.forEach((calendarId, index) => {
    const calendar = CalendarApp.getCalendarById(calendarId);
    if (!calendar) throw new Error('Cannot access Court ' + (index + 1) + ' calendar; incomplete snapshot was not sent');
    const sourceEvents = calendar.getEvents(windowStart, windowEnd);
    if (!Array.isArray(sourceEvents)) throw new Error('Court calendar returned an invalid event list');
    sourceEvents.forEach(event => {
      const title = event.getTitle() || '';
      const record = {
        eventId: event.getId(), calendarId: calendarId, court: 'Padel ' + (index + 1),
        customer: title.slice(0, 180), startTime: event.getStartTime().toISOString(),
        endTime: event.getEndTime().toISOString(),
      };
      if (typeof event.getLastUpdated === 'function') record.sourceUpdatedAt = event.getLastUpdated().toISOString();
      if (title.includes(PLAYTOMIC_TAG)) reservations.push(record);
      else events.push(record);
    });
  });
  return { schemaVersion: 1, complete: true, generatedAt: new Date().toISOString(),
    windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString(),
    calendars: calendars, events: events, reservations: reservations };
}

function bookingSyncEndpoint_(path) {
  const base = RAILWAY_WEBHOOK_URL.replace(/\/webhook\/catchcorner\/?$/, '');
  if (base === RAILWAY_WEBHOOK_URL) throw new Error('Invalid Railway webhook URL');
  return base + path;
}

// Read-only migration preview: no source properties or Playtomic blocks change.
function previewBookingRevisionSync() {
  const response = UrlFetchApp.fetch(bookingSyncEndpoint_('/sync/calendar/preview'), {
    method: 'POST', contentType: 'application/json', headers: { 'x-webhook-secret': WEBHOOK_SECRET },
    payload: JSON.stringify(collectBookingCalendarSnapshot_()), muteHttpExceptions: true,
  });
  if (response.getResponseCode() !== 200) throw new Error('Preview failed: HTTP ' + response.getResponseCode());
  const report = JSON.parse(response.getContentText());
  if (report.dryRun !== true) throw new Error('Worker did not confirm read-only preview');
  Logger.log(JSON.stringify({ dryRun: true, plannedCounts: report.plannedCounts,
    changes: report.changes.filter(item => item.action !== 'verify_existing').slice(0, 50) }));
  return report;
}

function postCalendarSnapshot_(snapshot) {
  let lastError;
  for (let attempt = 0; attempt < WEBHOOK_ATTEMPTS_PER_RUN; attempt++) {
    try {
      const response = UrlFetchApp.fetch(bookingSyncEndpoint_('/sync/calendar'), {
        method: 'POST', contentType: 'application/json', headers: { 'x-webhook-secret': WEBHOOK_SECRET },
        payload: JSON.stringify(snapshot), muteHttpExceptions: true,
      });
      const status = response.getResponseCode();
      const body = String(response.getContentText() || '');
      if (status < 200 || status >= 300) throw new Error('Railway snapshot HTTP ' + status + ': ' + body.slice(0, 500));
      const parsed = JSON.parse(body);
      if (typeof parsed.accepted !== 'boolean') throw new Error('Worker returned an invalid snapshot acknowledgement');
      return parsed;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < WEBHOOK_ATTEMPTS_PER_RUN) {
        Utilities.sleep(Number(WEBHOOK_RETRY_DELAYS_MS[Math.min(attempt, WEBHOOK_RETRY_DELAYS_MS.length - 1)] || 0));
      }
    }
  }
  throw lastError;
}

function checkCalendarSyncAlerts_() {
  const response = UrlFetchApp.fetch(bookingSyncEndpoint_('/admin/sync'), {
    method: 'GET', headers: { 'x-webhook-secret': WEBHOOK_SECRET }, muteHttpExceptions: true,
  });
  if (response.getResponseCode() !== 200) throw new Error('Could not read Railway reconciliation status: HTTP ' + response.getResponseCode());
  const report = JSON.parse(String(response.getContentText() || '{}'));
  if (report.schemaVersion !== 1 || !Array.isArray(report.issues)) throw new Error('Invalid Railway reconciliation report');
  const props = PropertiesService.getScriptProperties();
  if (!report.issues.length) {
    if (props.getProperty('BOOKING_SYNC_ISSUE_DIGEST')) {
      GmailApp.sendEmail(BLOCKER_ALERT_EMAIL, 'RECOVERED: PLAYTOMIC BOOKING SYNC',
        'Previously reported calendar-to-Playtomic reconciliation issues are no longer active.');
      props.deleteProperty('BOOKING_SYNC_ISSUE_DIGEST');
      props.deleteProperty('BOOKING_SYNC_ISSUE_ALERT_AT');
    }
    return report;
  }
  const signature = report.issues.map(issue => [issue.key, issue.code,
    issue.booking && issue.booking.court, issue.booking && issue.booking.startTime,
    issue.booking && issue.booking.endTime].join('|')).sort().join('\n');
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, signature, Utilities.Charset.UTF_8)
    .map(value => ('0' + ((value + 256) % 256).toString(16)).slice(-2)).join('');
  const lastAt = props.getProperty('BOOKING_SYNC_ISSUE_ALERT_AT');
  if (props.getProperty('BOOKING_SYNC_ISSUE_DIGEST') !== digest || !lastAt || Date.now() - new Date(lastAt).getTime() >= 6 * 60 * 60 * 1000) {
    const details = report.issues.slice(0, 20).map(issue => {
      const booking = issue.booking || {};
      return [issue.key + ' — ' + issue.status, booking.customer || '',
        booking.court + ': ' + booking.startTime + ' to ' + booking.endTime,
        issue.message, 'Attempts: ' + (issue.attempts || 0),
        'Next attempt: ' + (issue.nextAttemptAt || 'manual review required')].join('\n');
    });
    GmailApp.sendEmail(BLOCKER_ALERT_EMAIL, 'ALERT: PLAYTOMIC BOOKING SYNC NEEDS ATTENTION',
      report.issues.length + ' booking synchronization issue(s).\n\n' + details.join('\n\n') +
      '\n\nThe automation retains existing blocks until a replacement is verified. No customer Playtomic reservations are cancelled automatically.');
    props.setProperty('BOOKING_SYNC_ISSUE_DIGEST', digest);
    props.setProperty('BOOKING_SYNC_ISSUE_ALERT_AT', new Date().toISOString());
  }
  return report;
}
