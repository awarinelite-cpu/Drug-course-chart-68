import { auth, db } from "./firebase.js";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

// Every page calls requireAuth() twice: once from its own script, once from
// nav.js (for the hamburger menu's name/role display). Without this cache
// that meant two full onAuthStateChanged + Firestore getDoc round trips on
// every single page load. Cache by uid so the second caller on the same
// page reuses the first call's result instead of refetching.
let cachedUid = null;
let cachedProfile = null;

// Figure out how many folders deep the current page is, so redirects work
// whether we're at / (index.html, admin.html, login.html) or /charts/*.html
function loginPath() {
  const inSubfolder = window.location.pathname.includes('/charts/') || window.location.pathname.includes('/nurses-report/');
  return inSubfolder ? '../login.html' : 'login.html';
}

export function requireAuth(onReady) {
  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      window.location.href = loginPath();
      return;
    }

    if (cachedUid === user.uid && cachedProfile) {
      window.currentUser = user;
      window.currentUserProfile = cachedProfile;
      onReady(user, cachedProfile);
      return;
    }

    const userRef = doc(db, "users", user.uid);
    let snap;
    try {
      snap = await getDoc(userRef);
    } catch (e) {
      alert("Couldn't reach the database: " + (e.code || e.message || 'unknown error') +
        "\n\nMake sure Firestore Database has been created for this Firebase project (Firebase Console > Firestore Database > Create database).");
      return;
    }

    if (!snap.exists()) {
      alert("Your account isn't set up yet. Please contact your admin.");
      await signOut(auth);
      window.location.href = loginPath();
      return;
    }

    const profile = snap.data();
    cachedUid = user.uid;
    cachedProfile = profile;
    window.currentUser = user;
    window.currentUserProfile = profile;
    onReady(user, profile);
  });
}

export function logout() {
  signOut(auth).then(() => { window.location.href = loginPath(); });
}
