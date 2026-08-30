// Copies the static web app (root of the repo) into www/, which is what
// Capacitor packages into the Android app as assets/public. Kept as a
// separate copy step (rather than pointing Capacitor's webDir straight at
// the repo root) so node_modules, android/, functions/, and this tooling
// itself never end up inside the APK.
//
// No build step, no bundler — this is a plain HTML/CSS/JS app (see
// index.html, charts/*.html, js/*.js), so "build" here just means "copy the
// right files to the right place."
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DEST = path.join(ROOT, "www");

// Anything not needed inside the Android app package.
const EXCLUDE = new Set([
  "node_modules",
  "android",
  "www",
  ".git",
  ".github",
  "functions",
  "scripts",
  "package.json",
  "package-lock.json",
  "capacitor.config.json",
  "firebase.json",
  "firestore.rules",
]);

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.copyFileSync(src, dest);
  }
}

fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(DEST, { recursive: true });

for (const entry of fs.readdirSync(ROOT)) {
  if (EXCLUDE.has(entry)) continue;
  copyRecursive(path.join(ROOT, entry), path.join(DEST, entry));
}

console.log(`Copied web app into ${DEST}`);
