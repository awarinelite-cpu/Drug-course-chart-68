// Shared constants and date helpers for the Nurses Report feature
// (role-select.html, overall-nurse.html, and eventually ward-nurse.html).

// The hospital's fixed ward list, in the same order as the paper "24 Hours
// Overall Report" — beds is the default bed capacity, editable per ward.
export const WARDS = [
  { key: 'ae',       label: 'A/E',       beds: 20 },
  { key: 'matbed',   label: 'MATBED',    beds: 20 },
  { key: 'matcot',   label: 'MAT COT',   beds: 20 },
  { key: 'officers', label: 'OFFICERS',  beds: 9  },
  { key: 'fmw1',     label: 'FMW I',     beds: 18 },
  { key: 'fsw2',     label: 'FSW II',    beds: 20 },
  { key: 'mmw',      label: 'MMW',       beds: 20 },
  { key: 'paedbed',  label: 'PAED BED',  beds: 10 },
  { key: 'paedcot',  label: 'PAED COT',  beds: 18 },
  { key: 'ortho',    label: 'ORTHO',     beds: 20 },
  { key: 'gynae',    label: 'GYNAE',     beds: 18 },
  { key: 'award',    label: 'A WARD',    beds: 44 },
  { key: 'fswext',   label: 'FSW EXT',   beds: 20 },
  { key: 'eco1',     label: 'ECO I',     beds: 3  },
  { key: 'eco2',     label: 'ECO II',    beds: 3  },
  { key: 'icu',      label: 'ICU',       beds: 6  },
  { key: 'amenity',  label: 'AMENITY',   beds: 3  },
  { key: 'msw',      label: 'MSW',       beds: 18 },
  { key: 'esw',      label: 'ESW',       beds: 20 }
];

// Numeric columns, in display order, matching the ward-level "24Hrs Ward
// Report" paper form. 'beds' is listed separately in the UI (it's capacity,
// not a daily movement figure) but included here too since it's still
// summed in the totals row.
export const STAT_FIELDS = [
  { key: 'beds',        label: 'Beds' },
  { key: 'occ',         label: 'Occ' },
  { key: 'vac',         label: 'Vac' },
  { key: 'adm',         label: 'Adm' },
  { key: 'disch',       label: 'Disch' },
  { key: 'dama',        label: 'Dama' },
  { key: 'transferIn',  label: 'Transfer In' },
  { key: 'transferOut', label: 'Transfer Out' },
  { key: 'ext',         label: 'Ext' },
  { key: 'sc',          label: 'S/C' },
  { key: 'vsc',         label: 'VS/C' },
  { key: 'absc',        label: 'Absc' },
  { key: 'bid',         label: 'BID' },
  { key: 'death',       label: 'Death' }
];

// A ward report is entered per shift, then totalled. 'beds' isn't collected
// per shift (it's the ward's fixed capacity) — every other STAT_FIELDS key
// is summed across shifts for the Total row and for the figure that feeds
// the Overall Nurse's ward-totals table.
export const SHIFTS = [
  { key: 'am', label: 'Am' },
  { key: 'pm', label: 'Pm' }
];

// Structured fields for each patient write-up under a ward's report,
// matching the paper form's per-patient block (name/age/sex/EMR/DOA plus
// a free-text diagnosis & orders note).
export const PATIENT_FIELDS = [
  { key: 'name',      label: 'Name',      type: 'text' },
  { key: 'age',       label: 'Age',       type: 'text' },
  { key: 'sex',       label: 'Sex',       type: 'text' },
  { key: 'emr',       label: 'EMR',       type: 'text' },
  { key: 'doa',       label: 'DOA',       type: 'text' },
  { key: 'diagnosis', label: 'Diagnosis', type: 'textarea' },
  { key: 'notes',     label: 'Notes / Orders', type: 'textarea' }
];

function pad(n) { return String(n).padStart(2, '0'); }

// Ward is Africa/Lagos — WAT, UTC+1 year-round, no DST — matching the
// convention already used in functions/index.js and js/push.js, so this
// doesn't depend on whatever timezone the nurse's own device is set to.
function wardLocalParts(d) {
  const wat = new Date(d.getTime() + 60 * 60 * 1000);
  return { y: wat.getUTCFullYear(), m: wat.getUTCMonth(), day: wat.getUTCDate(), hour: wat.getUTCHours() };
}

// 24-hour report periods run 6:00 AM to 6:00 AM the next day (same
// convention as the Intake & Output chart's PERIOD_START_HOUR) — a time
// before 6 AM still belongs to the period that started the previous day.
export function reportDateId(d = new Date()) {
  const p = wardLocalParts(d);
  const base = new Date(Date.UTC(p.y, p.m, p.day - (p.hour < 6 ? 1 : 0)));
  return base.getUTCFullYear() + '-' + pad(base.getUTCMonth() + 1) + '-' + pad(base.getUTCDate());
}

// Matches the paper report's header line, e.g.
// "24 HOURS OVERALL REPORT WEF 0600HRS OF 15/08/26 TO 0600HRS OF 16/08/26"
export function reportPeriodLabel(dateId) {
  const [y, m, d] = dateId.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d));
  const end = new Date(Date.UTC(y, m - 1, d + 1));
  const fmt = dt => pad(dt.getUTCDate()) + '/' + pad(dt.getUTCMonth() + 1) + '/' + String(dt.getUTCFullYear()).slice(2);
  return '24 HOURS OVERALL REPORT WEF 0600HRS OF ' + fmt(start) + ' TO 0600HRS OF ' + fmt(end);
}

// The Overall Nurse role runs Monday–Sunday, identified by that Monday's
// ward-local date — avoids ISO week-number ambiguity across year boundaries.
export function weekId(d = new Date()) {
  const p = wardLocalParts(d);
  const date = new Date(Date.UTC(p.y, p.m, p.day));
  const dow = date.getUTCDay(); // 0=Sun..6=Sat
  date.setUTCDate(date.getUTCDate() - ((dow + 6) % 7));
  return date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate());
}
