import { requireAuth } from "./auth-guard.js";
import { loadPatientHeader, getPatientIdFromUrl } from "./chart-common.js";
import { lockBackTo } from "./back-guard.js";
import { db } from "./firebase.js";
import {
  collection, addDoc, deleteDoc, doc, getDoc, setDoc, onSnapshot, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

// columns entries support:
//   { key, label, type }                 — normal entered field
//   { key, label, type: 'select', options: [...], otherOption?, otherPlaceholder? }
//                                         — dropdown; when otherOption is set and selected,
//                                           an extra textarea appears and its text is folded
//                                           into the saved value as "<otherOption>: <text>"
//   { key, label, computed: true }       — value is filled in by deriveRows(), no input is rendered for it
//   { ..., abnormal: (value, row) => bool, deficitShade?: true } — shades the cell for quick visual flagging
//   { ..., popup: true }                 — table cell shows a truncated one-line preview; tapping it
//                                           opens a small popup with the full text (same pattern as the
//                                           Diagnosis field on the Drug Course Chart)

// Lazily-built popup used by any 'popup: true' column to show a cell's full text
// on tap, without cluttering the narrow table cell. Built once and reused.
let fieldPopupEls = null;
function ensureFieldPopup() {
  if (fieldPopupEls) return fieldPopupEls;
  const overlay = document.createElement('div');
  overlay.className = 'field-popup-overlay no-print';
  overlay.innerHTML =
    '<div class="field-popup-box">' +
      '<div class="field-popup-header"><h3></h3><button type="button" class="field-popup-close" aria-label="Close">&times;</button></div>' +
      '<div class="field-popup-body"><p class="field-popup-text"></p></div>' +
    '</div>';
  document.body.appendChild(overlay);
  const close = () => { overlay.style.display = 'none'; };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('.field-popup-close').addEventListener('click', close);
  fieldPopupEls = {
    overlay,
    title: overlay.querySelector('.field-popup-header h3'),
    text: overlay.querySelector('.field-popup-text')
  };
  return fieldPopupEls;
}
function openFieldPopup(label, value) {
  const els = ensureFieldPopup();
  els.title.textContent = label;
  els.text.textContent = value || '(Not entered)';
  els.overlay.style.display = 'flex';
}
//
// Optional top-level options:
//   deriveRows(ascRows) — given entries sorted oldest→newest, return the same rows with any
//                         computed fields (e.g. a running balance) attached.
//   summary: { label, storeAt: [collName, docId], archivedKey, compute(rawRows) => {intake, output, balance} }
//          — renders a small auto-updating, auto-saved 24-hour totals card above the table.
//            archivedKey names the field on a closed admission doc holding the totals that were
//            preserved at archive time (compute() re-derives "today", which is meaningless for a
//            historical record, so archived views prefer the preserved snapshot when present).

export function initEntryChart({ collectionName, columns, deriveRows, summary }) {
  const patientId = getPatientIdFromUrl();
  if (!patientId) { window.location.href = '../index.html'; return; }
  lockBackTo('../index.html');

  // If ?admission=<id> is present we're viewing this chart as part of a closed-out
  // admission folder (referred/transferred/discharged) — read-only, no entry form.
  const admissionId = new URLSearchParams(window.location.search).get('admission');
  const isArchived = !!admissionId;

  const STATUS_LABELS = { referred: 'Referred to another hospital', transferred: 'Transferred to another ward', discharged: 'Discharged' };

  function buildHeadRow() {
    const thead = document.getElementById('entryHead');
    const trh = document.createElement('tr');
    columns.forEach(col => { const th = document.createElement('th'); th.textContent = col.label; trh.appendChild(th); });
    if (!isArchived) {
      const thAction = document.createElement('th');
      thAction.className = 'no-print';
      trh.appendChild(thAction);
    }
    thead.appendChild(trh);
  }

  // Sorts oldest→newest, runs deriveRows() to attach computed fields (e.g. balance),
  // then returns newest→oldest for display.
  function withDerivedRows(rawRows) {
    const asc = rawRows.slice().sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    const derived = typeof deriveRows === 'function' ? deriveRows(asc) : asc;
    return derived.slice().sort((a, b) => (b.time || '').localeCompare(a.time || ''));
  }

  function cellValue(row, col) {
    return (row[col.key] !== undefined && row[col.key] !== null && row[col.key] !== '') ? row[col.key] : '';
  }

  // Fills a <td> for one column/row — a plain text cell, or (for popup:true
  // columns) a truncated preview that opens the full text on tap.
  function fillCell(td, col, row) {
    const value = cellValue(row, col);
    if (col.popup) {
      td.textContent = value;
      td.classList.add('popup-cell');
      td.title = 'Tap to view full text';
      td.addEventListener('click', () => openFieldPopup(col.label, value));
    } else {
      td.textContent = value;
    }
  }

  function applyCellShading(td, col, row) {
    if (typeof col.abnormal === 'function') {
      const raw = row[col.key];
      if (raw !== undefined && raw !== null && raw !== '' && col.abnormal(raw, row)) {
        td.classList.add(col.deficitShade ? 'flag-deficit' : 'flag-abnormal');
      }
    }
  }

  function renderSummaryCard(rawRows, presetTotals) {
    if (!summary) return;
    const totals = presetTotals || summary.compute(rawRows);
    const label = presetTotals && summary.archivedLabel ? summary.archivedLabel : summary.label;
    let box = document.getElementById('ioSummaryBox');
    if (!box) {
      box = document.createElement('div');
      box.id = 'ioSummaryBox';
      box.className = 'card-box';
      const table = document.querySelector('table.entries').closest('.card-box');
      table.parentNode.insertBefore(box, table);
    }
    const deficit = totals.balance < 0;
    box.innerHTML =
      '<h3 style="margin-top:0;">' + label + '</h3>' +
      '<div style="display:flex; gap:18px; flex-wrap:wrap; font-size:14px;">' +
      '<div><b>Total Intake:</b> ' + totals.intake + ' ml</div>' +
      '<div><b>Total Output:</b> ' + totals.output + ' ml</div>' +
      '<div class="' + (deficit ? 'flag-deficit' : '') + '" style="padding:2px 8px; border-radius:4px;"><b>Balance:</b> ' + totals.balance + ' ml' + (deficit ? ' (deficit)' : '') + '</div>' +
      '</div>' +
      '<div style="font-size:11px; color:#777; margin-top:6px;">' + (presetTotals ? 'Saved at the time this admission was closed.' : 'Recalculates automatically as entries are added, and saves every 24 hours.') + '</div>';
  }

  async function saveSummary(rawRows) {
    if (!summary || !summary.storeAt || isArchived) return;
    const totals = summary.compute(rawRows);
    const [collName, docId] = summary.storeAt;
    try {
      await setDoc(doc(db, 'patients', patientId, collName, docId), {
        ...totals,
        periodDate: new Date().toISOString().slice(0, 10),
        updatedAt: serverTimestamp()
      }, { merge: true });
    } catch (e) { /* summary is a convenience record — a failed save here isn't fatal */ }
  }

  requireAuth(async (user, profile) => {
    await loadPatientHeader(patientId, { name: 'pb_name', meta: 'pb_meta', allergy: 'pb_allergy' });

    if (isArchived) {
      // Hide the "New Reading/Entry" box entirely — nothing can be added to a closed admission.
      const formBox = document.getElementById('entryForm').closest('.card-box');
      if (formBox) formBox.style.display = 'none';

      const admSnap = await getDoc(doc(db, 'patients', patientId, 'admissions', admissionId));
      const admData = admSnap.exists() ? admSnap.data() : {};

      const container = document.querySelector('.container');
      const allergyBox = document.getElementById('pb_allergy');
      const banner = document.createElement('div');
      banner.style.cssText = 'background:#fef3c7; border:1px solid #f59e0b; color:#78350f; font-weight:bold; padding:8px 12px; border-radius:6px; margin-top:10px; font-size:13px;';
      banner.textContent = 'Archived chart — ' + (admData.archiveReasonLabel || STATUS_LABELS[admData.archiveReason] || 'Closed') + (admData.archivedAtDisplay ? ' on ' + admData.archivedAtDisplay : '');
      container.insertBefore(banner, allergyBox.nextSibling);

      buildHeadRow();
      const tbody = document.getElementById('entryBody');
      const rawRows = (admData[collectionName] || []);
      if (summary) {
        // Prefer the totals preserved at archive time (compute() re-derives "today",
        // which doesn't mean anything for a historical record).
        const preserved = summary.archivedKey ? admData[summary.archivedKey] : null;
        renderSummaryCard(rawRows, preserved || undefined);
      }
      const entries = withDerivedRows(rawRows);
      if (!entries.length) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = columns.length;
        td.textContent = 'No entries recorded for this admission.';
        td.style.color = '#777';
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
      }
      entries.forEach(row => {
        const tr = document.createElement('tr');
        columns.forEach(col => {
          const td = document.createElement('td');
          fillCell(td, col, row);
          applyCellShading(td, col, row);
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      return;
    }

    // Build the entry form fields (skip computed columns — those are auto-filled)
    const formDiv = document.getElementById('entryForm');
    columns.filter(col => !col.computed).forEach(col => {
      const wrap = document.createElement('div');
      wrap.className = 'field';
      wrap.style.flex = '1 1 140px';
      const label = document.createElement('label');
      label.textContent = col.label;
      wrap.appendChild(label);

      if (col.type === 'select') {
        const select = document.createElement('select');
        select.id = 'in_' + col.key;
        (col.options || []).forEach(opt => {
          const o = document.createElement('option');
          o.value = opt; o.textContent = opt;
          select.appendChild(o);
        });
        wrap.appendChild(select);
        if (col.otherOption) {
          const otherInput = document.createElement('textarea');
          otherInput.id = 'in_' + col.key + '_other';
          otherInput.placeholder = col.otherPlaceholder || 'Please specify';
          otherInput.rows = 1;
          otherInput.style.cssText = 'display:none; width:100%; margin-top:4px; font-family:inherit;';
          select.addEventListener('change', () => {
            otherInput.style.display = (select.value === col.otherOption) ? 'block' : 'none';
          });
          wrap.appendChild(otherInput);
        }
      } else {
        const input = document.createElement('input');
        input.type = col.type || 'text';
        input.id = 'in_' + col.key;
        wrap.appendChild(input);
      }
      formDiv.appendChild(wrap);
    });

    const timeInput = document.getElementById('in_time');
    if (timeInput) {
      const now = new Date();
      now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
      timeInput.value = now.toISOString().slice(0, 16);
    }

    // Reads a form field's value — for a 'select' column with otherOption, folds the
    // paired textarea's text into the saved value as "<otherOption>: <text>".
    function readInputValue(col) {
      const el = document.getElementById('in_' + col.key);
      if (!el) return '';
      if (col.type === 'select' && col.otherOption && el.value === col.otherOption) {
        const otherEl = document.getElementById('in_' + col.key + '_other');
        const otherText = otherEl ? otherEl.value.trim() : '';
        return otherText ? (col.otherOption + ': ' + otherText) : col.otherOption;
      }
      return el.value;
    }

    document.getElementById('addEntryBtn').onclick = async () => {
      const data = {};
      columns.filter(col => !col.computed).forEach(col => { data[col.key] = readInputValue(col); });
      if (!data.time) { alert('Please set the time.'); return; }
      data.createdAt = serverTimestamp();
      data.enteredBy = profile.name;
      await addDoc(collection(db, 'patients', patientId, collectionName), data);
      columns.filter(col => !col.computed).forEach(col => {
        if (col.key === 'time') return;
        const el = document.getElementById('in_' + col.key);
        if (col.type === 'select') {
          el.selectedIndex = 0;
          const otherEl = document.getElementById('in_' + col.key + '_other');
          if (otherEl) { otherEl.value = ''; otherEl.style.display = 'none'; }
        } else {
          el.value = '';
        }
      });
    };

    // Build the results table header
    buildHeadRow();

    // Live-updating table body
    const tbody = document.getElementById('entryBody');
    let latestRawRows = [];
    const q = query(collection(db, 'patients', patientId, collectionName), orderBy('time', 'desc'));
    onSnapshot(q, (snap) => {
      latestRawRows = [];
      snap.forEach(d => latestRawRows.push({ id: d.id, ...d.data() }));

      if (summary) { renderSummaryCard(latestRawRows); saveSummary(latestRawRows); }

      tbody.innerHTML = '';
      if (snap.empty) {
        const tr = document.createElement('tr');
        const td = document.createElement('td');
        td.colSpan = columns.length + 1;
        td.textContent = 'No entries yet.';
        td.style.color = '#777';
        tr.appendChild(td);
        tbody.appendChild(tr);
        return;
      }
      const rows = withDerivedRows(latestRawRows);
      rows.forEach(row => {
        const tr = document.createElement('tr');
        columns.forEach(col => {
          const td = document.createElement('td');
          fillCell(td, col, row);
          applyCellShading(td, col, row);
          tr.appendChild(td);
        });
        const tdAction = document.createElement('td');
        tdAction.className = 'no-print';
        const delBtn = document.createElement('button');
        delBtn.textContent = 'Delete';
        delBtn.className = 'btn btn-danger';
        delBtn.style.padding = '4px 8px';
        delBtn.style.fontSize = '11px';
        delBtn.onclick = () => {
          if (confirm('Delete this entry?')) deleteDoc(doc(db, 'patients', patientId, collectionName, row.id));
        };
        tdAction.appendChild(delBtn);
        tr.appendChild(tdAction);
        tbody.appendChild(tr);
      });
    });

    // Keep the 24-hour summary current even with no new entries (e.g. rolling
    // past midnight into a new period) by recomputing + re-saving periodically.
    if (summary) {
      setInterval(() => {
        renderSummaryCard(latestRawRows);
        saveSummary(latestRawRows);
      }, 15 * 60 * 1000);
    }
  });
}
