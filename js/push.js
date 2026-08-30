// js/push.js — Push (FCM) registration for "drug due" alerts, for both the
// plain web app (Web Push via service worker) and the Capacitor-wrapped
// Android app (native FCM via @capacitor/push-notifications). Which path
// runs is decided at the top of each function by isNativePlatform().
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
import { DEFAULT_ALARM_SETTINGS, watchAlarmSettings } from "./alarm-settings.js";

// Admin-configured alarm policy (sound / appearance / repeat / quiet hours /
// which frequencies alert) — see js/alarm-settings.js and the "Alarm
// Settings" card in admin.html. Kept live via a Firestore listener so a
// change the admin makes applies to already-open tabs without a reload.
// Starts at the built-in defaults so an alarm firing before the first
// snapshot arrives still behaves sensibly rather than doing nothing.
let currentAlarmSettings = { ...DEFAULT_ALARM_SETTINGS };
let alarmSettingsWatchStarted = false;
function ensureAlarmSettingsWatch() {
  if (alarmSettingsWatchStarted) return;
  alarmSettingsWatchStarted = true;
  watchAlarmSettings(db, (settings) => { currentAlarmSettings = settings; });
}

// Ward is Africa/Lagos — UTC+1 year-round, no DST — matching
// functions/index.js's WARD_UTC_OFFSET, so quiet-hours-driven behavior here
// stays consistent with what the server already decided to (not) send.
function isWithinQuietHours(settings, now) {
  const qh = settings.quietHours;
  if (!qh || !qh.enabled) return false;
  const wardNow = new Date(now.getTime() + 60 * 60 * 1000); // UTC -> WAT
  const minutesNow = wardNow.getUTCHours() * 60 + wardNow.getUTCMinutes();
  const [sh, sm] = (qh.start || "22:00").split(":").map(Number);
  const [eh, em] = (qh.end || "06:00").split(":").map(Number);
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  if (startMin === endMin) return false; // zero-length window — treat as disabled
  if (startMin < endMin) return minutesNow >= startMin && minutesNow < endMin;
  // Wraps past midnight (e.g. 22:00 -> 06:00)
  return minutesNow >= startMin || minutesNow < endMin;
}

// Firestore doc IDs can't contain "/", and an FCM token can be 140+ chars —
// both fine for a doc ID, but slashes do show up in some token formats, so
// swap them for a safe placeholder rather than risk a bad path.
function tokenDocId(token) {
  return token.replace(/\//g, "_");
}

// Capacitor injects window.Capacitor at runtime in the wrapped Android app
// (see the APK build — android/app/src/main/java/.../MainActivity.java) but
// this file also still runs unmodified in a plain mobile/desktop browser
// tab, where window.Capacitor doesn't exist at all. Everything below
// branches on this once, rather than duplicating the check everywhere.
function isNativePlatform() {
  return typeof window !== "undefined" &&
    !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

// Only used on the native branch, to remember which FCM token this device
// registered so disablePushForThisDevice() can delete the right Firestore
// doc later without needing to ask the native layer again.
const LAST_TOKEN_KEY = "narhy_lastPushToken";

// Notification.permission, once granted, can never be un-granted by JS —
// only the user can revoke it from browser/OS settings. So it can't be used
// on its own to tell whether THIS APP currently has an active subscription:
// a nurse who has tapped "turn off" still shows permission "granted" forever
// after the first opt-in. Track our own on/off flag locally instead, and
// treat it as the source of truth alongside permission.
const LOCAL_FLAG = "narhy_dosePushEnabled";

export function pushIsEnabled() {
  if (isNativePlatform()) {
    // Permission state lives with the native OS/plugin here, not
    // window.Notification (which a WebView may not even implement). The
    // local flag is set only after a real successful native registration
    // below, so it's a safe stand-in.
    return localStorage.getItem(LOCAL_FLAG) === "1";
  }
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

  if (isNativePlatform()) {
    return enablePushNative(uid, note);
  }

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
  registerForegroundHandler(messaging);

  return token;
}

// Native path: uses @capacitor/push-notifications (window.Capacitor.Plugins
// .PushNotifications, injected at runtime — no bundler needed to call it
// from a plain script) instead of the Firebase Web SDK's getToken()/
// getMessaging(), which talks to the browser's Push API and isn't the
// mechanism a wrapped native WebView actually uses. The plugin talks
// straight to Android's own FCM registration, which is also what makes
// alerts work while the app is fully backgrounded or closed — not just
// foregrounded like the web service-worker path.
async function enablePushNative(uid, note) {
  const PushNotifications = window.Capacitor?.Plugins?.PushNotifications;
  if (!PushNotifications) {
    throw new Error("Push notifications plugin isn't available in this build.");
  }

  note("Requesting notification permission…");
  const permStatus = await withStepTimeout(
    PushNotifications.requestPermissions(), 8000, "requesting notification permission"
  );
  if (permStatus.receive !== "granted") {
    throw new Error("Notification permission was not granted.");
  }

  note("Registering with Google (FCM)…");
  const token = await withStepTimeout(
    new Promise((resolve, reject) => {
      // register() itself resolves with nothing — the actual token arrives
      // asynchronously via the 'registration' event, so the real "wait for
      // this" promise is built around that listener, not the call below.
      let regListener, errListener;
      const cleanup = () => { regListener?.remove(); errListener?.remove(); };
      PushNotifications.addListener("registration", (token) => {
        cleanup();
        resolve(token.value);
      }).then((l) => { regListener = l; });
      PushNotifications.addListener("registrationError", (err) => {
        cleanup();
        reject(new Error(err?.error || "Native push registration failed."));
      }).then((l) => { errListener = l; });
      PushNotifications.register();
    }),
    15000,
    "registering for push with FCM"
  );

  note("Saving the push token…");
  await withStepTimeout(
    setDoc(doc(db, "users", uid, "pushTokens", tokenDocId(token)), {
      token,
      userAgent: navigator.userAgent + " (Android app)",
      createdAt: serverTimestamp()
    }),
    8000,
    "saving the push token to your account"
  );
  localStorage.setItem(LOCAL_FLAG, "1");
  localStorage.setItem(LAST_TOKEN_KEY, token);
  registerForegroundHandlerNative(PushNotifications);

  return token;
}

// Wires up the in-page alarm+banner for messages that arrive while this tab
// is open and focused. Firebase only auto-shows the OS notification tray for
// BACKGROUND messages (handled by sw.js) — a foreground tab has to catch the
// message itself via onMessage, or nothing happens at all on that tab.
//
// Called two places: right after a nurse taps "Alerts On" (below), and once
// automatically on every page load via initForegroundAlertsIfEnabled() (see
// js/nav.js, which runs on every page) — otherwise the alarm would only ever
// fire on whichever single page happened to be open at the moment enabling
// ran, and silently do nothing on every other page/reload after that.
let foregroundHandlerAttached = false;
function registerForegroundHandler(messaging) {
  if (foregroundHandlerAttached) return; // onMessage isn't idempotent — guard against double-firing
  foregroundHandlerAttached = true;
  ensureAlarmSettingsWatch();
  onMessage(messaging, (payload) => {
    const n = payload.notification || {};
    const d = payload.data || {};
    showForegroundBanner(n.title, n.body, d.link);
  });
}

// Native counterpart to registerForegroundHandler() above. Deliberately NOT
// built on the Firebase Web SDK's onMessage — that talks to the browser
// Push API, which may not initialize the same way (or at all) inside a
// WebView. PushNotifications.addListener('pushNotificationReceived', ...)
// is Capacitor's own bridge from native FCM straight to JS, independent of
// whether the Web SDK's isSupported() checks pass in this environment.
let nativeForegroundHandlerAttached = false;
function registerForegroundHandlerNative(PushNotifications) {
  if (nativeForegroundHandlerAttached) return;
  nativeForegroundHandlerAttached = true;
  ensureAlarmSettingsWatch();
  PushNotifications.addListener("pushNotificationReceived", (notification) => {
    const d = notification.data || {};
    showForegroundBanner(notification.title, notification.body, d.link);
  });
}

// Call on every page load (regardless of whether push was just enabled here
// or on a totally different device/session previously) so a tab that's open
// and in the foreground always has a live alarm handler, not just the tab
// that happened to be open when the nurse first tapped "Alerts On".
export async function initForegroundAlertsIfEnabled() {
  if (!pushIsEnabled()) return;

  if (isNativePlatform()) {
    const PushNotifications = window.Capacitor?.Plugins?.PushNotifications;
    if (PushNotifications) registerForegroundHandlerNative(PushNotifications);
    return;
  }

  if (!("Notification" in window) || !("serviceWorker" in navigator)) return;
  try {
    if (!(await isSupported())) return;
    const messaging = getMessaging(app);
    registerForegroundHandler(messaging);
  } catch (e) {
    // Non-fatal — background alerts (sw.js) still work even if this fails.
  }
}

export async function disablePushForThisDevice(uid) {
  localStorage.removeItem(LOCAL_FLAG);

  if (isNativePlatform()) {
    const token = localStorage.getItem(LAST_TOKEN_KEY);
    localStorage.removeItem(LAST_TOKEN_KEY);
    if (token) {
      await deleteDoc(doc(db, "users", uid, "pushTokens", tokenDocId(token))).catch(() => {});
    }
    // Deliberately not calling any native "unregister" — the plugin has no
    // real equivalent, and leaving the OS-level FCM registration in place
    // is harmless once its Firestore token doc is gone: the Cloud Function
    // has nothing left to send to.
    return;
  }

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

// Generates the alarm tone itself with an oscillator rather than an audio
// file — no asset to host. NOTE: this does NOT sidestep autoplay-blocking.
// A brand-new AudioContext always starts life "suspended" and can only move
// to "running" as a result of a real user gesture (tap/click/keydown)
// somewhere on the page. A push message arriving via onMessage is not a
// user gesture, so if the AudioContext were created fresh here (as before),
// a nurse who reloaded the tab and never tapped anything would get a
// silently-scheduled alarm: no errors, banner shows, but zero sound.
//
// Fix: keep ONE AudioContext for the whole page lifetime and unlock it the
// moment the nurse makes ANY tap/keypress/touch on the page — not
// necessarily on the alarm itself. In real use the chart is being tapped on
// constantly, so by the time a dose alarm needs to fire, the context is
// almost always already unlocked from ordinary use. As a second line of
// defense, we also call resume() right when the alarm starts and on every
// beep — if the nurse's very first interaction with the page turns out to
// be tapping the alert banner itself, the context unlocks at that moment
// and the beeps starting from the next 900ms tick become audible.
let sharedCtx = null;
function getSharedAudioContext() {
  if (!sharedCtx) {
    try {
      sharedCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      return null;
    }
  }
  return sharedCtx;
}

function tryResume(ctx) {
  if (ctx && ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
}

// Attach once at module load — cheap, passive listeners that just try to
// wake the shared context up on the very first real interaction anywhere on
// the page, long before any alarm needs to fire.
(function unlockAudioOnFirstGesture() {
  const tryUnlock = () => tryResume(getSharedAudioContext());
  ["pointerdown", "keydown", "touchstart"].forEach((evt) => {
    document.addEventListener(evt, tryUnlock, { passive: true });
  });
})();

// One "cycle" of oscillator scheduling per admin-selected sound. Each
// function schedules whatever notes/sweep it needs starting at ctx.currentTime
// and returns nothing — startAlarmLoop() below re-invokes the whole function
// on every tick for "repeat" mode, or once for "once" mode.
const SOUND_PATTERNS = {
  // Classic two-tone beep (like a basic monitor alarm).
  beep(ctx) {
    [880, 660].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = freq;
      gain.gain.value = 0.2;
      osc.connect(gain).connect(ctx.destination);
      const start = ctx.currentTime + i * 0.22;
      osc.start(start);
      osc.stop(start + 0.18);
    });
  },
  // Gentler two-note sine chime — quieter and rounder than the square-wave beep.
  chime(ctx) {
    [988, 784].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = ctx.currentTime + i * 0.28;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.5);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.52);
    });
  },
  // Continuous rising/falling sweep, like an ambulance siren.
  siren(ctx) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    gain.gain.value = 0.16;
    const start = ctx.currentTime;
    const dur = 0.85;
    osc.frequency.setValueAtTime(500, start);
    osc.frequency.linearRampToValueAtTime(1000, start + dur / 2);
    osc.frequency.linearRampToValueAtTime(500, start + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(start);
    osc.stop(start + dur);
  },
  // Three sharp, quick high beeps — the most attention-grabbing preset.
  urgent(ctx) {
    for (let i = 0; i < 3; i++) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = 1046;
      gain.gain.value = 0.22;
      osc.connect(gain).connect(ctx.destination);
      const start = ctx.currentTime + i * 0.16;
      osc.start(start);
      osc.stop(start + 0.09);
    }
  }
};

function playSoundPattern(ctx, soundType) {
  (SOUND_PATTERNS[soundType] || SOUND_PATTERNS.beep)(ctx);
}

// Repeats the admin-selected sound until stop() is called. Capped at
// MAX_ALARM_MS as a safety net in case nobody's at the phone to dismiss it,
// so it can't ring indefinitely in a quiet ward. When repeat is "once" it
// plays a single pattern and never loops (the MAX_ALARM_MS cap still applies
// to the banner separately, in showForegroundBanner).
const MAX_ALARM_MS = 60000;

function startAlarmLoop(soundType, repeatMode) {
  let stopped = false;
  const ctx = getSharedAudioContext();
  if (!ctx) return () => {}; // Web Audio unavailable — banner still shows, just silently

  tryResume(ctx);

  function tick() {
    if (stopped) return;
    tryResume(ctx); // cheap no-op once running; catches a late unlock mid-alarm
    if (ctx.state !== "running") return; // still locked — stay silent, don't throw
    playSoundPattern(ctx, soundType);
  }

  tick();
  const interval = repeatMode === "once" ? null : setInterval(tick, 900);
  const maxTimer = repeatMode === "once" ? null : setTimeout(stop, MAX_ALARM_MS);

  function stop() {
    if (stopped) return;
    stopped = true;
    if (interval) clearInterval(interval);
    if (maxTimer) clearTimeout(maxTimer);
    // Don't close() — this context is shared across the page's lifetime so
    // the next alarm can reuse an already-unlocked context.
  }
  return stop;
}

// Vibration pattern for the "vibrate" appearance — only Chrome/Android
// WebViews implement navigator.vibrate (iOS Safari silently has no effect),
// so this is a best-effort enhancement, not the primary alert channel there.
function tryVibrate(repeatMode) {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  const pulse = [250, 150, 250];
  navigator.vibrate(repeatMode === "once" ? pulse : pulse.concat([300, 250, 150, 250]));
}

function showForegroundBanner(title, body, link) {
  const settings = currentAlarmSettings;

  // Quiet hours suppress the whole foreground alert (sound, banner, and
  // vibration) — the Cloud Function already skips sending in this window for
  // most cases, but a device's local clock or a delayed message could still
  // land here right at the boundary, so this is a second line of defense.
  if (isWithinQuietHours(settings, new Date())) return;

  const appearance = settings.appearance || "banner_sound";
  const showBanner = appearance !== "sound_only";
  const playSound = appearance === "banner_sound" || appearance === "sound_only";
  const vibrate = appearance === "vibrate";

  const stopAlarm = playSound ? startAlarmLoop(settings.sound, settings.repeat) : () => {};
  if (vibrate) tryVibrate(settings.repeat);

  if (!showBanner) {
    // Sound Only — nothing to click to dismiss; let the alarm's own repeat/
    // cap behavior end it (single pattern for "once", MAX_ALARM_MS for "repeat").
    if (settings.repeat === "once") return;
    setTimeout(stopAlarm, MAX_ALARM_MS);
    return;
  }

  const banner = document.createElement("div");
  banner.setAttribute("role", "alert");
  banner.style.cssText =
    "position:fixed; top:12px; left:50%; transform:translateX(-50%); z-index:6000; " +
    "background:#111827; color:#fff; padding:12px 16px; border-radius:10px; " +
    "box-shadow:0 4px 16px rgba(0,0,0,.3); max-width:92vw; cursor:pointer; font-size:13px;";
  banner.innerHTML =
    '<div style="font-weight:bold; margin-bottom:2px;">' + (title || "Drug due") + "</div>" +
    "<div>" + (body || "") + "</div>" +
    '<div style="margin-top:6px; font-size:11px; opacity:.75;">Tap to dismiss</div>';

  const cleanup = () => { stopAlarm(); banner.remove(); };
  banner.addEventListener("click", () => {
    if (link) window.location.href = link;
    cleanup();
  });
  document.body.appendChild(banner);
  setTimeout(cleanup, MAX_ALARM_MS);
}
