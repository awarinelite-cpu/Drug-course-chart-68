import { db } from "./firebase.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

export function getPatientIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get('patient');
}

function escapeHtml(s) {
  return (s || '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}

export async function loadPatientHeader(patientId, elIds) {
  const snap = await getDoc(doc(db, 'patients', patientId));
  if (!snap.exists()) {
    alert('Patient not found.');
    window.location.href = '../index.html';
    return null;
  }
  const p = snap.data();
  document.getElementById(elIds.name).textContent = p.name || 'Unnamed';
  document.getElementById(elIds.meta).textContent =
    'EMR: ' + (p.emr || 'N/A') + '   |   Diagnosis: ' + (p.diagnosis || 'Not specified');

  if (elIds.allergy) {
    const box = document.getElementById(elIds.allergy);
    const val = (p.allergies || '').trim();
    if (val && !/^(none|nil|none known)$/i.test(val)) {
      box.innerHTML = '<div class="allergy-alert">ALLERGY ALERT: ' + escapeHtml(val) + '</div>';
    } else {
      box.innerHTML = '';
    }
  }
  return p;
}
