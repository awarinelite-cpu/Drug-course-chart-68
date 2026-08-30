// functions/index.js
//
// Runs every 1 minute. A nurse's phone only ever shows one patient's chart
// at a time and is only open briefly, so alerts can't live in the page —
// they have to come from the server, watching every patient's drug chart at
// once, and push straight to each nurse's phone regardless of what's open.
//
// Due-time model: rather than a fixed ward-wide drug round, each drug's next
// dose is computed from ITS OWN last-administered time + its frequency's
// interval (falling back to when the order was created/started, for a drug
// that's never been given yet). See js/push.js and profile.html for the
// client side, and charts/drug-course-chart.html for where drugs/chartRows
// are written.

const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();
const messaging = admin.messaging();

// Ward is Africa/Lagos — WAT, UTC+1 year-round, no DST — so this offset is
// safe to hardcode rather than depending on the function runtime's TZ.
const WARD_UTC_OFFSET = '+01:00';

// Only standard, unambiguous frequencies are covered for now. STAT (one-off),
// PRN (as-needed), and any custom free-text frequency are intentionally
// skipped — there's no reliable interval to compute a "next due" from.
const INTERVAL_HOURS = {
  OD: 24, BD: 12, TDS: 8, QDS: 6,
  Q4H: 4, Q6H: 6, Q8H: 8, Q12H: 12,
  Weekly: 168
};

function toWardDate(dateStr, timeStr) {
  if (!dateStr || !timeStr) return null;
  const d = new Date(`${dateStr}T${timeStr}:00${WARD_UTC_OFFSET}`);
  return isNaN(d.getTime()) ? null : d;
}

// Same doc admin.html writes to and js/alarm-settings.js reads on the client
// (settings/alarm) — mirrored here by hand since Cloud Functions can't
// import that browser ES module. Only the two fields that affect whether a
// push gets sent at all are used server-side; sound/appearance/repeat are
// purely a foreground-tab concern handled in js/push.js.
const DEFAULT_FREQUENCIES = Object.keys(INTERVAL_HOURS);

async function loadAlarmSettings() {
  try {
    const snap = await db.collection('settings').doc('alarm').get();
    const d = snap.exists ? snap.data() : {};
    const frequencies = Array.isArray(d.frequencies) && d.frequencies.length
      ? d.frequencies.filter((f) => DEFAULT_FREQUENCIES.includes(f))
      : DEFAULT_FREQUENCIES;
    const qh = d.quietHours || {};
    const glucose = d.glucose || {};
    const validGlucoseIntervals = [1, 2, 3, 4, 6, 8, 12, 24];
    return {
      frequencies,
      quietHours: { enabled: !!qh.enabled, start: qh.start || '22:00', end: qh.end || '06:00' },
      glucose: {
        enabled: d.glucose ? !!glucose.enabled : true, // default on if admin hasn't touched this setting yet
        intervalHours: validGlucoseIntervals.includes(Number(glucose.intervalHours)) ? Number(glucose.intervalHours) : 4
      }
    };
  } catch (e) {
    console.error('Failed to load alarm settings, defaulting to all frequencies / no quiet hours:', e);
    return {
      frequencies: DEFAULT_FREQUENCIES,
      quietHours: { enabled: false, start: '22:00', end: '06:00' },
      glucose: { enabled: true, intervalHours: 4 }
    };
  }
}

// Ward-local "now", for comparing against the admin's quiet-hours start/end
// (which are entered as ward-local HH:mm, e.g. "22:00").
function wardMinutesNow(now) {
  const wardNow = new Date(now.getTime() + 60 * 60 * 1000); // UTC -> WAT (+1, no DST)
  return wardNow.getUTCHours() * 60 + wardNow.getUTCMinutes();
}

function isWithinQuietHours(quietHours, now) {
  if (!quietHours.enabled) return false;
  const minutesNow = wardMinutesNow(now);
  const [sh, sm] = quietHours.start.split(':').map(Number);
  const [eh, em] = quietHours.end.split(':').map(Number);
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  if (startMin === endMin) return false; // zero-length window — treat as disabled
  if (startMin < endMin) return minutesNow >= startMin && minutesNow < endMin;
  return minutesNow >= startMin || minutesNow < endMin; // wraps past midnight
}

// Chart rows are matched back to a drug by its "S/N" column, which contains
// the drug's 1-based row number (see refreshDrugSnoList() in
// charts/drug-course-chart.html) — same lookup drug-course-chart.html itself
// uses to infer a drug's start date from its administration history.
function lastGivenFor(drugIndex, chartRows) {
  let latest = null;
  for (const row of chartRows || []) {
    const nums = (row.sno || '').match(/\d+/g) || [];
    if (!nums.some((n) => parseInt(n, 10) === drugIndex + 1)) continue;
    const dt = toWardDate(row.date, row.time);
    if (dt && (!latest || dt > latest)) latest = dt;
  }
  return latest;
}

function computeDueAt(drug, chartRows, drugIndex) {
  const lastGiven = lastGivenFor(drugIndex, chartRows);
  if (lastGiven) {
    const intervalHours = INTERVAL_HOURS[drug.frequency];
    return new Date(lastGiven.getTime() + intervalHours * 3600 * 1000);
  }
  // Never administered yet — anchor to whichever of these is available.
  if (drug.startDate) return toWardDate(drug.startDate, '00:00');
  if (drug.createdAt) {
    const d = new Date(drug.createdAt);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// Mirrors CHART_DEFS in charts/blood-glucose.html — each chart type's column
// layout by index, so the scheduler can tell a reading cell from date/time/
// remark bookkeeping. Kept in sync by hand, same as INTERVAL_HOURS above.
// dateIdx/timeIdx feed toWardDate(); readingIdxs are the glucose-value
// columns — a row counts as "a reading was taken" if any of them is filled.
const GLUCOSE_CHART_COLUMNS = {
  '6point': { dateIdx: 0, timeIdx: 1, readingIdxs: [2, 3, 4, 5, 6, 7] },
  '3point': { dateIdx: 0, timeIdx: 1, readingIdxs: [2, 3, 4] }
};

function lastGlucoseReadingAt(rows, chartType) {
  const cols = GLUCOSE_CHART_COLUMNS[chartType] || GLUCOSE_CHART_COLUMNS['6point'];
  let latest = null;
  for (const row of rows || []) {
    const hasReading = cols.readingIdxs.some((i) => (row[i] || '').toString().trim() !== '');
    if (!hasReading) continue;
    const dt = toWardDate(row[cols.dateIdx], row[cols.timeIdx]);
    if (dt && (!latest || dt > latest)) latest = dt;
  }
  return latest;
}

// Reads every nurse's registered push token across all users (see
// js/push.js's pushTokens subcollection). Shared by both scheduled checks
// below so each does this Firestore read only once per its own cycle.
async function getTokenEntries(usersSnap) {
  const tokenEntries = []; // { token, ref }
  await Promise.all(
    usersSnap.docs.map(async (u) => {
      const tokensSnap = await db.collection('users').doc(u.id).collection('pushTokens').get();
      tokensSnap.forEach((t) => {
        if (t.data().token) tokenEntries.push({ token: t.data().token, ref: t.ref });
      });
    })
  );
  return tokenEntries;
}

exports.checkDueDrugs = onSchedule(
  { schedule: 'every 1 minutes', timeZone: 'Africa/Lagos', region: 'us-central1' },
  async () => {
    const now = new Date();
    const alarmSettings = await loadAlarmSettings();

    // Quiet hours suppress sending entirely for this cycle. Doses that go
    // due during the window are deliberately left un-marked (lastAlertedFor
    // is only set for drugs actually processed below), so the very next
    // cycle after quiet hours end will catch them as still-due and alert
    // then — nothing is silently missed, it's just delayed.
    if (isWithinQuietHours(alarmSettings.quietHours, now)) {
      console.log('Within admin-configured quiet hours — skipping this cycle.');
      return;
    }

    const [patientsSnap, chartsSnap, usersSnap] = await Promise.all([
      db.collection('patients').get(),
      db.collectionGroup('drugCourseChart').get(),
      db.collection('users').get()
    ]);

    const patientNames = {};
    patientsSnap.forEach((d) => { patientNames[d.id] = d.data().name || 'Unnamed patient'; });

    const tokenEntries = await getTokenEntries(usersSnap);
    if (tokenEntries.length === 0) {
      console.log('No nurses subscribed to dose alerts — nothing to send.');
      return;
    }

    const dueByPatient = {}; // patientId -> [ "Drug name (FREQ)" ]
    const chartUpdates = [];

    chartsSnap.forEach((chartDoc) => {
      if (chartDoc.id !== 'main') return; // this collection only ever holds one doc, 'main'
      const patientId = chartDoc.ref.parent.parent.id;
      const data = chartDoc.data();
      const drugs = Array.isArray(data.drugs) ? data.drugs : [];
      const chartRows = Array.isArray(data.rows) ? data.rows : [];
      let changed = false;

      drugs.forEach((drug, i) => {
        if (!INTERVAL_HOURS[drug.frequency]) return; // STAT / PRN / custom text — not covered yet
        if (!alarmSettings.frequencies.includes(drug.frequency)) return; // admin turned this frequency off
        if (drug.action && drug.action !== 'Ongoing') return; // discontinued/withheld/completed/other

        const dueAt = computeDueAt(drug, chartRows, i);
        if (!dueAt || dueAt > now) return;

        const dueSlotKey = dueAt.toISOString();
        if (drug.lastAlertedFor === dueSlotKey) return; // already alerted for this exact dose

        drug.lastAlertedFor = dueSlotKey;
        changed = true;

        const label = `${drug.name || 'Unnamed drug'} (${drug.frequency})`;
        (dueByPatient[patientId] = dueByPatient[patientId] || []).push(label);
      });

      if (changed) chartUpdates.push(chartDoc.ref.update({ drugs }));
    });

    const patientIds = Object.keys(dueByPatient);
    if (patientIds.length === 0) {
      await Promise.all(chartUpdates);
      console.log('No doses due this cycle.');
      return;
    }

    const tokens = tokenEntries.map((t) => t.token);
    let tokensPruned = false; // token validity is the same across every send below, so only act on it once

    const sends = patientIds.map(async (patientId) => {
      const labels = dueByPatient[patientId];
      const name = patientNames[patientId] || 'a patient';
      const title = labels.length === 1 ? `Drug due — ${name}` : `${labels.length} drugs due — ${name}`;
      const body = labels.slice(0, 3).join(', ') + (labels.length > 3 ? `, +${labels.length - 3} more` : '');

      const resp = await messaging.sendEachForMulticast({
        tokens,
        notification: { title, body },
        data: {
          link: `./charts/drug-course-chart.html?patient=${patientId}`,
          tag: `due-${patientId}`
        },
        // android.notification.channel_id is only consulted by the Android
        // FCM SDK (harmless no-op for plain web-push tokens from browsers).
        // It matches the "dose-due-alerts" channel created natively in the
        // Capacitor APK's MainActivity — without pinning this explicitly,
        // Android falls back to an auto-created channel that isn't
        // guaranteed to have sound or high-importance heads-up behavior.
        // priority: 'high' asks FCM/the device to wake from Doze and
        // deliver promptly rather than batching for later.
        android: {
          priority: 'high',
          notification: { channelId: 'dose-due-alerts', sound: 'default' }
        }
      });

      if (!tokensPruned) {
        tokensPruned = true;
        resp.responses.forEach((r, idx) => {
          if (r.success) return;
          const code = r.error?.code || '';
          // Token is stale (app uninstalled, permission revoked, etc.) — remove it
          // so future cycles don't keep trying to send to it.
          if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
            chartUpdates.push(tokenEntries[idx].ref.delete());
          }
        });
      }
    });

    await Promise.all([...chartUpdates, ...sends]);
    console.log(`Sent due-dose alerts for ${patientIds.length} patient(s) to ${tokens.length} device(s).`);
  }
);

// Runs every 1 minute, same cadence and admin-configured quiet-hours/sound
// policy as checkDueDrugs above, but for the glycemic chart instead of the
// drug course chart. Unlike drugs (which have a per-row frequency like
// BD/TDS), the glycemic chart has no such field — "due" is instead a single
// ward-wide interval (settings/alarm.glucose.intervalHours, admin-configured
// in admin.html) counted from EACH PATIENT'S OWN last recorded reading (the
// Date+Time of their most recent row with any glucose value filled in). A
// patient with no reading yet has no baseline to count from, so they're
// skipped rather than alerted immediately on admission.
exports.checkDueGlucoseChecks = onSchedule(
  { schedule: 'every 1 minutes', timeZone: 'Africa/Lagos', region: 'us-central1' },
  async () => {
    const now = new Date();
    const alarmSettings = await loadAlarmSettings();

    if (!alarmSettings.glucose.enabled) {
      console.log('Glucose check reminders are turned off in Alarm Settings.');
      return;
    }
    if (isWithinQuietHours(alarmSettings.quietHours, now)) {
      console.log('Within admin-configured quiet hours — skipping glucose reminders this cycle.');
      return;
    }

    const [patientsSnap, chartsSnap, usersSnap] = await Promise.all([
      db.collection('patients').get(),
      db.collectionGroup('bloodGlucose').get(),
      db.collection('users').get()
    ]);

    const patientNames = {};
    patientsSnap.forEach((d) => { patientNames[d.id] = d.data().name || 'Unnamed patient'; });

    const tokenEntries = await getTokenEntries(usersSnap);
    if (tokenEntries.length === 0) {
      console.log('No nurses subscribed to dose alerts — nothing to send.');
      return;
    }

    const duePatientIds = [];
    const chartUpdates = [];
    const intervalMs = alarmSettings.glucose.intervalHours * 3600 * 1000;

    chartsSnap.forEach((chartDoc) => {
      if (chartDoc.id !== 'main') return; // this collection only ever holds one doc, 'main'
      const patientId = chartDoc.ref.parent.parent.id;
      const data = chartDoc.data();
      const chartType = data.chartType === '3point' ? '3point' : '6point';
      const rows = Array.isArray(data.rows) ? data.rows : [];

      const lastReadingAt = lastGlucoseReadingAt(rows, chartType);
      if (!lastReadingAt) return; // no reading recorded yet — nothing to base a "due" time on

      const dueAt = new Date(lastReadingAt.getTime() + intervalMs);
      if (dueAt > now) return;

      const dueSlotKey = dueAt.toISOString();
      if (data.lastAlertedForGlucose === dueSlotKey) return; // already alerted for this exact slot

      chartUpdates.push(chartDoc.ref.update({ lastAlertedForGlucose: dueSlotKey }));
      duePatientIds.push(patientId);
    });

    if (duePatientIds.length === 0) {
      await Promise.all(chartUpdates);
      console.log('No glucose checks due this cycle.');
      return;
    }

    const tokens = tokenEntries.map((t) => t.token);
    let tokensPruned = false; // token validity is the same across every send below, so only act on it once

    const sends = duePatientIds.map(async (patientId) => {
      const name = patientNames[patientId] || 'a patient';

      const resp = await messaging.sendEachForMulticast({
        tokens,
        notification: { title: `Glucose check due — ${name}`, body: 'A blood glucose reading is due.' },
        data: {
          link: `./charts/blood-glucose.html?patient=${patientId}`,
          tag: `glucose-${patientId}`
        },
        android: {
          priority: 'high',
          notification: { channelId: 'dose-due-alerts', sound: 'default' }
        }
      });

      if (!tokensPruned) {
        tokensPruned = true;
        resp.responses.forEach((r, idx) => {
          if (r.success) return;
          const code = r.error?.code || '';
          if (code.includes('registration-token-not-registered') || code.includes('invalid-argument')) {
            chartUpdates.push(tokenEntries[idx].ref.delete());
          }
        });
      }
    });

    await Promise.all([...chartUpdates, ...sends]);
    console.log(`Sent glucose-check reminders for ${duePatientIds.length} patient(s) to ${tokens.length} device(s).`);
  }
);
