import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

/**
 * Screenshot gallery for reviewing the UI by eye.
 *
 * Captures every meaningful surface in both colour schemes. Dark mode is not
 * decoration here: `globals.css` ships a full dark token set, and an audit page
 * whose verification banner loses contrast in dark mode would undermine exactly
 * the moment it exists to support.
 */

const SHOTS = process.env.SHOTS_DIR ?? "./e2e/screenshots/gallery";
mkdirSync(SHOTS, { recursive: true });

const DASH = "http://localhost:3001";
const CAPTURE = "http://localhost:3002";
const BACKEND = process.env.BACKEND_URL ?? "http://localhost:3000";

/**
 * Stand the simulated device at whatever hub the backend actually has. A fixed
 * coordinate here produces screenshots of a refused GPS fix as soon as the hub
 * is relocated, which looks like a broken app rather than a stale script.
 */
async function hubLocation() {
  const login = await fetch(`${BACKEND}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email: "operator@proofchain.local",
      password: "operator-dev-password",
    }),
  });
  const { accessToken } = await login.json();
  const hubs = await (
    await fetch(`${BACKEND}/hubs`, { headers: { authorization: `Bearer ${accessToken}` } })
  ).json();
  if (!hubs[0]) throw new Error("no hubs seeded — run npm run seed");
  return hubs[0];
}

const hub = await hubLocation();

const browser = await chromium.launch();

async function dashboard(scheme) {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
    colorScheme: scheme,
  });
  const page = await context.newPage();

  await page.goto(`${DASH}/login`, { waitUntil: "networkidle" });
  await page.fill('input[name="email"]', "operator@proofchain.local");
  await page.fill('input[name="password"]', "operator-dev-password");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 15000 }).catch(() => {});

  await page.goto(`${DASH}/`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SHOTS}/${scheme}-1-batches.png`, fullPage: true });

  const href = await page.locator('a[href^="/batches/"]').first().getAttribute("href");
  const id = href.split("/")[2];

  await page.goto(`${DASH}/batches/${id}`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SHOTS}/${scheme}-2-batch.png`, fullPage: true });

  await page.goto(`${DASH}/events`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SHOTS}/${scheme}-3-events.png`, fullPage: true });

  await page.goto(`${DASH}/batches/${id}/report`, { waitUntil: "networkidle" });
  await page.screenshot({ path: `${SHOTS}/${scheme}-4-report.png`, fullPage: true });

  // Contrast of the verification banner is the one thing that must survive both schemes.
  const banner = await page.evaluate(() => {
    const el = document.querySelector(".proof");
    if (!el) return null;
    const s = getComputedStyle(el);
    return { state: el.dataset.state, bg: s.backgroundColor, fg: s.color };
  });
  console.log(`  ${scheme}: proof banner ${JSON.stringify(banner)}`);

  await context.close();
  return id;
}

console.log("Dashboard");
await dashboard("light");
await dashboard("dark");

console.log("Capture PWA");
for (const scheme of ["light", "dark"]) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    colorScheme: scheme,
    permissions: ["geolocation"],
    geolocation: { latitude: hub.lat, longitude: hub.lng },
  });
  const page = await context.newPage();
  await page.goto(CAPTURE, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);

  await page.fill("#backend", "http://localhost:3000");
  await page.fill("#email", "operator@proofchain.local");
  await page.fill("#password", "operator-dev-password");
  await page.click("#load");
  await page.waitForTimeout(2500);
  await page.click("#enrol");
  await page.waitForTimeout(2500);

  await page.fill("#weight", "18.250");
  await page.click("#locate");
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${SHOTS}/${scheme}-5-capture.png`, fullPage: true });
  await context.close();
}

await browser.close();
console.log(`\ngallery -> ${SHOTS}`);
