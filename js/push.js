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
const VAPID_KEY = "BAPXwiBktw0KdKPUWBfE4MG-399Nj-QPAvNJLbJJ5Uq5oojGI_kYARiKq_RexHJQmomYmzpAFsAq4t-fPYj0DfY";

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

// Race a step against a timeout with its own label, so a hang reports
// exactly which step it got stuck on instead of one generic message
// covering the whole multi-step flow.
function withStepTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out waiting on: ${label}. Check your internet connection and try again.`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// nav.js registers sw.js on every page load, but swallows any failure
// silently (the app should still work online without an offline shell) — so
// there's no guarantee a working registration exists by the time push needs
// one. Rather than trust navigator.serviceWorker.ready, which just hangs
// forever if that earlier registration never succeeded, look for an existing
// registration and register fresh here if there isn't one, then explicitly
// wait for it to actually activate.
async function getActiveRegistration() {
  let registration = await navigator.serviceWorker.getRegistration();
  if (!registration) {
    registration = await navigator.serviceWorker.register("./sw.js");
  }
  if (registration.active) return registration;

  const worker = registration.installing || registration.waiting;
  if (!worker) return registration; // nothing to wait on — assume it's fine

  await new Promise((resolve) => {
    if (worker.state === "activated") { resolve(); return; }
    worker.addEventListener("statechange", function onChange() {
      if (worker.state === "activated") {
        worker.removeEventListener("statechange", onChange);
        resolve();
      }
    });
  });
  return registration;
}

// Call from a user gesture (button tap) — browsers require that for the
// permission prompt to show at all. onProgress(label), if given, fires right
// before each step starts — so if a step hangs, whatever's on screen when it
// freezes tells you exactly which one, even if the timeout itself never
// fires (e.g. the tab gets backgrounded and browsers throttle timers).
export async function enablePushForThisDevice(uid, onProgress) {
  const note = (label) => { if (onProgress) onProgress(label); };

  if (!("Notification" in window) || !("serviceWorker" in navigator)) {
    throw new Error("This browser doesn't support push notifications.");
  }
  note("Checking browser support…");
  if (!(await withStepTimeout(isSupported(), 8000, "checking browser support"))) {
    throw new Error("This browser doesn't support Firebase push messaging.");
  }
  if (VAPID_KEY.startsWith("REPLACE_WITH")) {
    throw new Error("Push isn't configured yet (missing VAPID key) — ask your app admin.");
  }

  note("Requesting notification permission…");
  const permission = await withStepTimeout(Notification.requestPermission(), 8000, "requesting notification permission");
  if (permission !== "granted") {
    throw new Error("Notification permission was not granted.");
  }

  // sw.js also handles background FCM messages — see the importScripts
  // block at the top of that file.
  note("Waiting for the service worker…");
  const registration = await withStepTimeout(getActiveRegistration(), 10000, "service worker becoming ready");
  const messaging = getMessaging(app);
  note("Requesting a push token from Google…");
  const token = await withStepTimeout(
    getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: registration }),
    15000,
    "requesting a push token from Google"
  );
  if (!token) throw new Error("Could not get a push token from the browser.");

  note("Saving the push token…");
  await withStepTimeout(
    setDoc(doc(db, "users", uid, "pushTokens", tokenDocId(token)), {
      token,
      userAgent: navigator.userAgent,
      createdAt: serverTimestamp()
    }),
    8000,
    "saving the push token to your account"
  );
  localStorage.setItem(LOCAL_FLAG, "1");

  // Foreground messages (app open and on-screen right now) don't trigger the
  // OS notification tray automatically — show an in-page banner instead.
  onMessage(messaging, (payload) => {
    const n = payload.notification || {};
    const d = payload.data || {};
    showForegroundBanner(n.title, n.body, d.link);
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
