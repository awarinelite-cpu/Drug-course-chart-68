// functions/index.js
//
// Runs every 2 minutes. A nurse's phone only ever shows one patient's chart
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

exports.checkDueDrugs = onSchedule(
  { schedule: 'every 2 minutes', timeZone: 'Africa/Lagos', region: 'us-central1' },
  async () => {
    const now = new Date();

    const [patientsSnap, chartsSnap, usersSnap] = await Promise.all([
      db.collection('patients').get(),
      db.collectionGroup('drugCourseChart').get(),
      db.collection('users').get()
    ]);

    const patientNames = {};
    patientsSnap.forEach((d) => { patientNames[d.id] = d.data().name || 'Unnamed patient'; });

    const tokenEntries = []; // { token, ref }
    await Promise.all(
      usersSnap.docs.map(async (u) => {
        const tokensSnap = await db.collection('users').doc(u.id).collection('pushTokens').get();
        tokensSnap.forEach((t) => {
          if (t.data().token) tokenEntries.push({ token: t.data().token, ref: t.ref });
        });
      })
    );

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
      const chartRows = Array.isArray(data.chartRows) ? data.chartRows : [];
      let changed = false;

      drugs.forEach((drug, i) => {
        if (!INTERVAL_HOURS[drug.frequency]) return; // STAT / PRN / custom text — not covered yet
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
