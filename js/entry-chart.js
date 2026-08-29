import { requireAuth } from "./auth-guard.js";
import { loadPatientHeader, getPatientIdFromUrl } from "./chart-common.js";
import { lockBackTo } from "./back-guard.js";
import { db } from "./firebase.js";
import {
  collection, addDoc, deleteDoc, doc, getDoc, onSnapshot, query, orderBy, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

export function initEntryChart({ collectionName, columns }) {
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
      const entries = ((admData[collectionName] || [])).slice().sort((a, b) => (b.time || '').localeCompare(a.time || ''));
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
          td.textContent = row[col.key] || '';
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
      return;
    }

    // Build the entry form fields
    const formDiv = document.getElementById('entryForm');
    columns.forEach(col => {
      const wrap = document.createElement('div');
      wrap.className = 'field';
      wrap.style.flex = '1 1 140px';
      const label = document.createElement('label');
      label.textContent = col.label;
      const input = document.createElement('input');
      input.type = col.type || 'text';
      input.id = 'in_' + col.key;
      wrap.appendChild(label);
      wrap.appendChild(input);
      formDiv.appendChild(wrap);
    });

    const timeInput = document.getElementById('in_time');
    if (timeInput) {
      const now = new Date();
      now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
      timeInput.value = now.toISOString().slice(0, 16);
    }

    document.getElementById('addEntryBtn').onclick = async () => {
      const data = {};
      columns.forEach(col => { data[col.key] = document.getElementById('in_' + col.key).value; });
      if (!data.time) { alert('Please set the time.'); return; }
      data.createdAt = serverTimestamp();
      data.enteredBy = profile.name;
      await addDoc(collection(db, 'patients', patientId, collectionName), data);
      columns.forEach(col => { if (col.key !== 'time') document.getElementById('in_' + col.key).value = ''; });
    };

    // Build the results table header
    buildHeadRow();

    // Live-updating table body
    const tbody = document.getElementById('entryBody');
    const q = query(collection(db, 'patients', patientId, collectionName), orderBy('time', 'desc'));
    onSnapshot(q, (snap) => {
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
      snap.forEach(d => {
        const row = d.data();
        const tr = document.createElement('tr');
        columns.forEach(col => {
          const td = document.createElement('td');
          td.textContent = row[col.key] || '';
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
          if (confirm('Delete this entry?')) deleteDoc(doc(db, 'patients', patientId, collectionName, d.id));
        };
        tdAction.appendChild(delBtn);
        tr.appendChild(tdAction);
        tbody.appendChild(tr);
      });
    });
  });
}

