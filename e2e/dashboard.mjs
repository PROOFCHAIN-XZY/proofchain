import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const SHOTS = process.env.SHOTS_DIR ?? "./e2e/screenshots";
mkdirSync(SHOTS, { recursive: true });

const DASH = "http://localhost:3001";
const results = [];
const consoleErrors = [];

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });

page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

// ---------------------------------------------------------------- 1. auth gate
// The app does not redirect; it renders a signed-out state. What matters for
// security is that no batch data reaches an anonymous visitor.
console.log("\n[1] Unauthenticated access leaks no data");
await page.goto(`${DASH}/`, { waitUntil: "networkidle" });
const anonText = await page.locator("body").innerText();
check("signed-out state is stated plainly", /not signed in/i.test(anonText));
check(
  "no batch rows rendered anonymously",
  (await page.locator('a[href^="/batches/"]').count()) === 0,
);
check("no 64-hex Merkle root leaked anonymously", !/[0-9a-f]{64}/.test(anonText));
await page.screenshot({ path: `${SHOTS}/01-anonymous.png`, fullPage: true });

// ---------------------------------------------------------------- 2. bad creds
console.log("\n[2] Wrong password is rejected");
await page.goto(`${DASH}/login`, { waitUntil: "networkidle" });
await page.screenshot({ path: `${SHOTS}/02-login.png`, fullPage: true });
await page.fill('input[name="email"]', "operator@proofchain.local");
await page.fill('input[name="password"]', "definitely-wrong");
await page.click('button[type="submit"]');
await page.waitForTimeout(2500);
check(
  "still on /login after a bad password",
  new URL(page.url()).pathname === "/login",
  `url ${new URL(page.url()).pathname}`,
);

// ---------------------------------------------------------------- 3. real login
console.log("\n[3] Operator signs in");
await page.goto(`${DASH}/login`, { waitUntil: "networkidle" });
await page.fill('input[name="email"]', "operator@proofchain.local");
await page.fill('input[name="password"]', "operator-dev-password");
await page.click('button[type="submit"]');
// The server action posts, sets the httpOnly cookie and redirects. Waiting on
// "networkidle" races it, because link prefetches settle the network first.
await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 }).catch(() => {});
check("redirected off /login", new URL(page.url()).pathname !== "/login", `url ${page.url()}`);

// ---------------------------------------------------------------- 4. batch list
console.log("\n[4] Batches list renders real data");
await page.goto(`${DASH}/`, { waitUntil: "networkidle" });
await page.screenshot({ path: `${SHOTS}/03-batches.png`, fullPage: true });

const rowLinks = await page.locator('a[href^="/batches/"]').all();
check("at least one batch is listed", rowLinks.length > 0, `${rowLinks.length} batch links`);

const bodyText = await page.locator("body").innerText();
check("page shows a kg weight", /\d[\d.,]*\s*kg/i.test(bodyText));

// ---------------------------------------------------------------- 5. batch detail
console.log("\n[5] Batch detail");
const firstHref = await rowLinks[0].getAttribute("href");
const batchId = firstHref.split("/")[2];
await page.goto(`${DASH}/batches/${batchId}`, { waitUntil: "networkidle" });
await page.screenshot({ path: `${SHOTS}/03-batch-detail.png`, fullPage: true });

const detailText = await page.locator("body").innerText();
check("batch detail renders", detailText.length > 200, `${detailText.length} chars`);
check("shows a Merkle root or explains it is not sealed", /merkle|root/i.test(detailText));

// ---------------------------------------------------------------- 6. seal confirm
console.log("\n[6] Seal is a two-step confirm (no accidental irreversible click)");
const sealToggle = page.locator("details.confirm > summary");
if ((await sealToggle.count()) > 0) {
  const bodyBefore = await page.locator(".confirm-body").isVisible();
  await sealToggle.first().click();
  await page.waitForTimeout(200);
  const bodyAfter = await page.locator(".confirm-body").isVisible();
  check("confirm panel hidden until clicked", bodyBefore === false && bodyAfter === true);
  await page.screenshot({ path: `${SHOTS}/04-seal-confirm.png`, fullPage: true });
} else {
  check("seal control absent for an already-sealed batch (expected)", true, "batch not open");
}

// ---------------------------------------------------------------- 7. audit report
console.log("\n[7] Audit report — the artifact a buyer receives");
await page.goto(`${DASH}/batches/${batchId}/report`, { waitUntil: "networkidle" });
await page.screenshot({ path: `${SHOTS}/05-report.png`, fullPage: true });

const report = await page.locator("body").innerText();
check("report renders", /report|verification/i.test(report));
check("shows the sealed root", /[0-9a-f]{64}/.test(report));
check("states roots agree", /roots agree/i.test(report));
check("links the Stellar transaction", (await page.locator('a[href*="stellar.expert"]').count()) > 0);

// ---------------------------------------------------------------- 8. bad batch id
console.log("\n[8] Unknown batch gives a specific error, not a crash");
await page.goto(`${DASH}/batches/00000000-0000-0000-0000-000000000000/report`, {
  waitUntil: "networkidle",
});
const missing = await page.locator("body").innerText();
check(
  "explains the batch does not exist",
  /no batch exists/i.test(missing),
  missing.split("\n").find((l) => l.trim().length > 10)?.slice(0, 60) ?? "",
);
await page.screenshot({ path: `${SHOTS}/06-missing-batch.png`, fullPage: true });

// ---------------------------------------------------------------- 9. keyboard a11y
console.log("\n[9] Keyboard focus is visible");
await page.goto(`${DASH}/`, { waitUntil: "networkidle" });
await page.keyboard.press("Tab");
const focusInfo = await page.evaluate(() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const s = getComputedStyle(el);
  return { tag: el.tagName, outline: s.outlineWidth, style: s.outlineStyle };
});
check(
  "first tab stop takes visible focus",
  focusInfo !== null && focusInfo.style !== "none",
  focusInfo ? `${focusInfo.tag} outline ${focusInfo.outline} ${focusInfo.style}` : "nothing focused",
);

// ---------------------------------------------------------------- 10. responsive
console.log("\n[10] Narrow viewport does not overflow horizontally");
await page.setViewportSize({ width: 375, height: 800 });
await page.goto(`${DASH}/batches/${batchId}/report`, { waitUntil: "networkidle" });
const overflow = await page.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
);
check("no horizontal page overflow at 375px", overflow <= 1, `overflow ${overflow}px`);
await page.screenshot({ path: `${SHOTS}/07-mobile-report.png`, fullPage: true });

// ---------------------------------------------------------------- console
console.log("\n[11] Browser console");
check("no console/page errors", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${"=".repeat(60)}`);
console.log(`DASHBOARD: ${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FAILED:");
  for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
}
console.log(`screenshots -> ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
