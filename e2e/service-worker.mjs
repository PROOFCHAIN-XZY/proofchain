import { chromium } from "playwright";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

/**
 * Regression test for the deploy-bricking service worker.
 *
 * The original worker was cache-first for every same-origin GET, including HTML.
 * An installed phone therefore kept its first index.html forever; once a rebuild
 * rotated the hashed bundle names, that stale HTML pointed at files which no
 * longer existed and the app hung on its boot screen. A collector's phone became
 * unable to record a weigh-in, and no amount of reloading fixed it.
 *
 * This cannot be caught by the normal suite: a service worker only persists in a
 * persistent browser profile, and every other test runs in a fresh context.
 *
 * Requires the capture app to be served at :3002.
 */

const DIST = "/home/victor/Desktop/trash recycle/proofchain/apps/capture/dist";
const URL_ = process.env.CAPTURE_URL ?? "http://localhost:3002";
const PROFILE = process.env.SW_PROFILE ?? "/tmp/proofchain-sw-profile";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

execSync(`rm -rf ${PROFILE}`);
const context = await chromium.launchPersistentContext(PROFILE, { headless: true });
const page = await context.newPage();

console.log("\n[1] Worker installs and the app boots");
await page.goto(URL_, { waitUntil: "networkidle" });
await page.waitForTimeout(2500);
const registrations = await page.evaluate(() =>
  navigator.serviceWorker.getRegistrations().then((r) => r.length),
);
check("service worker registered", registrations === 1, `${registrations} registration(s)`);
check(
  "app boots past the placeholder",
  !(await page.locator("body").innerText()).includes("Loading capture"),
);

console.log("\n[2] A new deployment reaches an already-installed phone");
const indexPath = `${DIST}/index.html`;
const original = readFileSync(indexPath, "utf8");
writeFileSync(indexPath, original.replace("</head>", '<meta name="deploy-marker" content="v2"></head>'));
try {
  await page.goto(URL_, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  const sawUpdate = await page.evaluate(() => !!document.querySelector('meta[name="deploy-marker"]'));
  // The whole point: HTML must be network-first, or updates never ship.
  check("updated index.html is served, not the cached copy", sawUpdate);
} finally {
  writeFileSync(indexPath, original);
}

console.log("\n[3] Still works offline (the reason the worker exists)");
await page.goto(URL_, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);
await context.setOffline(true);
await page.goto(URL_, { waitUntil: "domcontentloaded" }).catch(() => {});
await page.waitForTimeout(1500);
const offlineText = await page.locator("body").innerText().catch(() => "");
check("app shell still loads with no network", offlineText.length > 0 && !offlineText.includes("ERR_"));
await context.setOffline(false);

console.log("\n[4] Old caches are purged on activation");
const cacheNames = await page.evaluate(() => caches.keys());
check(
  "only the current cache generation remains",
  cacheNames.length === 1,
  cacheNames.join(", "),
);

await context.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${"=".repeat(60)}`);
console.log(`SERVICE WORKER: ${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAILED: ${f.name}`);
process.exit(failed.length ? 1 : 0);
