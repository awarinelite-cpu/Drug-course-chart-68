// js/push.js — Web Push (FCM) registration for "drug due" alerts.
//
// One nurse's phone is only open briefly and only ever shows one patient at
// a time, so an in-page timer can't cover the whole ward. Instead: a Cloud
// Function (functions/index.js) runs on a schedule server-side, checks every
// patient's drug chart for doses that are due, and pushes a notification to
// every nurse who has opted in on this screen — regardless of which page (or
// whether the app) is open on their phone at that moment.
//
// Web Push VAPID public key — Firebase Console → Project Settings → Cloud
// Messaging → Web configuration → Web Push certificates.
const VAPID_KEY = "BDV2tyIpcpEof_9MBzU5Kzw8ZiAeOBHqDQXcUq9sPI-m-l0oG7QqGkfYeb4PxuFi4z2O2XFcOxOVeVcA_zvFXfQ";

import { app, db } from "./firebase.js";
import {
  getMessaging, getToken, onMessage, isSupported
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-messaging.js";
import { doc, setDoc, deleteDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

// Firestore doc IDs can't contain "/", and an FCM token can be 140+ chars —
// both fine for a doc ID, but slashes do show up in some token formats, so
// swap them for a safe placeholder rather than risk a bad path.
function tokenDocId(token) {
  return token.replace(/\//g, "_");
}

// Notification.permission, once granted, can never be un-granted by JS —
// only the user can revoke it from browser/OS settings. So it can't be used
// on its own to tell whether THIS APP currently has an active subscription:
// a nurse who has tapped "turn off" still shows permission "granted" forever
// after the first opt-in. Track our own on/off flag locally instead, and
// treat it as the source of truth alongside permission.
const LOCAL_FLAG = "narhy_dosePushEnabled";

export function pushIsEnabled() {
  return typeof Notification !== "undefined" &&
    Notification.permission === "granted" &&
    localStorage.getItem(LOCAL_FLAG) === "1";
}

// Call from a user gesture (button tap) — browsers require that for the
// permission prompt to show at all.
export async function enablePushForThisDevice(uid) {
  if (!("Notification" in window) || !("serviceWorker" in navigator)) {
    throw new Error("This browser doesn't support push notifications.");
  }
  if (!(await isSupported())) {
    throw new Error("This browser doesn't support Firebase push messaging.");
  }
  if (VAPID_KEY.startsWith("REPLACE_WITH")) {
    throw new Error("Push isn't configured yet (missing VAPID key) — ask your app admin.");
  }

  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }

  // sw.js (registered by nav.js on every page) also handles background FCM
  // messages — see the importScripts block at the top of that file.
  const registration = await navigator.serviceWorker.ready;
  const messaging = getMessaging(app);
  const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: registration });
  if (!token) throw new Error("Could not get a push token from the browser.");

  await setDoc(doc(db, "users", uid, "pushTokens", tokenDocId(token)), {
    token,
    userAgent: navigator.userAgent,
    createdAt: serverTimestamp()
  });
  localStorage.setItem(LOCAL_FLAG, "1");

  // Foreground messages (app open and on-screen right now) don't trigger the
  // OS notification tray automatically — show an in-page banner instead.
  onMessage(messaging, (payload) => {
    showForegroundBanner(payload.notification?.title, payload.notification?.body, payload.data?.link);
  });

  return token;
}

export async function disablePushForThisDevice(uid) {
  localStorage.removeItem(LOCAL_FLAG);
  if (!(await isSupported())) return;
  const messaging = getMessaging(app);
  let token;
  try {
    token = await getToken(messaging, { vapidKey: VAPID_KEY });
  } catch (e) {
    return; // nothing to clean up
  }
  if (token) {
    await deleteDoc(doc(db, "users", uid, "pushTokens", tokenDocId(token))).catch(() => {});
  }
}

function showForegroundBanner(title, body, link) {
  const banner = document.createElement("div");
  banner.setAttribute("role", "alert");
  banner.style.cssText =
    "position:fixed; top:12px; left:50%; transform:translateX(-50%); z-index:6000; " +
    "background:#111827; color:#fff; padding:12px 16px; border-radius:10px; " +
    "box-shadow:0 4px 16px rgba(0,0,0,.3); max-width:92vw; cursor:pointer; font-size:13px;";
  banner.innerHTML =
    '<div style="font-weight:bold; margin-bottom:2px;">' + (title || "Drug due") + "</div>" +
    "<div>" + (body || "") + "</div>";
  banner.addEventListener("click", () => {
    if (link) window.location.href = link;
    banner.remove();
  });
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 12000);
}
