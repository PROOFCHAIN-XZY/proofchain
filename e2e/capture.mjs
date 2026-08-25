import { chromium } from "playwright";

const SHOTS = process.env.SHOTS_DIR ?? "./e2e/screenshots";
const CAPTURE = "http://localhost:3002";
const results = [];
const consoleErrors = [];

function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const BACKEND = process.env.BACKEND_URL ?? "http://localhost:3000";

/** The device must stand at whatever hub this backend actually has. */
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
  const hub = hubs[0];
  if (!hub) throw new Error("no hubs seeded — run npm run seed");
  return hub;
}

const hub = await hubLocation();
console.log(`  (hub ${hub.code})`);

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, // a real field phone
});
const page = await context.newPage();
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

// ---------------------------------------------------------------- 1. boots
console.log("\n[1] App boots to the pairing screen");
await page.goto(CAPTURE, { waitUntil: "networkidle" });
await page.waitForTimeout(500);
const text = await page.locator("body").innerText();
check("renders the pairing step", /pair this phone/i.test(text));
check("shows a device public key", (await page.locator("code.meta").count()) > 0);
await page.screenshot({ path: `${SHOTS}/10-capture-pairing.png`, fullPage: true });

// ---------------------------------------------------------------- 2. key is real
console.log("\n[2] Device key is generated on-device and persisted");
const key1 = await page.locator("code.meta").first().innerText();
const stored = await page.evaluate(() => localStorage.getItem("proofchain.device.identity.v1"));
check("key stored locally", stored !== null);
check("public key is 32 bytes base64", key1.trim().length === 44, `${key1.trim().length} chars`);

const priv = await page.evaluate(() => {
  const raw = localStorage.getItem("proofchain.device.identity.v1");
  return raw ? JSON.parse(raw).privateKeyHex : null;
});
check("private key is 32 bytes of hex", priv !== null && priv.length === 64);

await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(400);
const key2 = await page.locator("code.meta").first().innerText();
check("same key survives a reload (phone is not re-enrolled)", key1 === key2);

// ---------------------------------------------------------------- 3. enrolment
console.log("\n[3] Operator enrols the phone against the live backend");
await page.fill("#backend", "http://localhost:3000");
await page.fill("#email", "operator@proofchain.local");
await page.fill("#password", "operator-dev-password");
await page.click("#load");
await page.waitForTimeout(2500);

const collectorCount = await page.locator("#collector option").count();
check("collectors loaded from the API", collectorCount > 0, `${collectorCount} collectors`);
const hubCount = await page.locator("#hub option").count();
check("hubs loaded from the API", hubCount > 0, `${hubCount} hubs`);
await page.screenshot({ path: `${SHOTS}/11-capture-enrol.png`, fullPage: true });

await page.click("#enrol");
await page.waitForTimeout(2500);
const afterEnrol = await page.locator("body").innerText();
check("advanced to the capture screen", /sign & queue|weight/i.test(afterEnrol));
await page.screenshot({ path: `${SHOTS}/12-capture-screen.png`, fullPage: true });

// ---------------------------------------------------------------- 4. input loss
console.log("\n[4] REGRESSION: a re-render must not eat a weight being typed");
const weightBox = page.locator("#weight");
if ((await weightBox.count()) === 0) {
  check("weight field present", false, "capture screen did not load");
} else {
  await weightBox.fill("12.5");
  // Force the exact re-render the 60 s sync timer causes.
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForTimeout(1500);
  const survived = await page.locator("#weight").inputValue();
  check("typed weight survives a background re-render", survived === "12.5", `value "${survived}"`);
}

// ---------------------------------------------------------------- 5. incomplete
console.log("\n[5] An incomplete weigh-in is refused, not silently queued");
await page.click("#commit");
await page.waitForTimeout(800);
const refusal = await page.locator("body").innerText();
check("states what is still missing", /still needed/i.test(refusal));
check(
  "names the missing photo",
  /photo/i.test(refusal),
  refusal.split("\n").find((l) => /still needed/i.test(l))?.slice(0, 70) ?? "",
);
await page.screenshot({ path: `${SHOTS}/13-capture-incomplete.png`, fullPage: true });

// ---------------------------------------------------------------- 7. queue empty
console.log("\n[7] Queue starts empty and is stated honestly");
const queueText = await page.locator("section.queue").innerText();
check("queue section renders", queueText.length > 0);
check("says nothing captured yet", /no weigh-ins captured yet/i.test(queueText));

// ---------------------------------------------------------------- 8. offline
console.log("\n[8] Offline is surfaced, and sync is disabled rather than failing");
await context.setOffline(true);
await page.evaluate(() => window.dispatchEvent(new Event("offline")));
await page.waitForTimeout(1200);
const offlineText = await page.locator("body").innerText();
check("masthead shows offline", /offline/i.test(offlineText));
const syncDisabled = await page.locator("#sync").isDisabled();
check("sync button disabled while offline", syncDisabled);
await page.screenshot({ path: `${SHOTS}/14-capture-offline.png`, fullPage: true });
await context.setOffline(false);

// ---------------------------------------------------------------- 9. a11y
console.log("\n[9] Touch targets are usable one-handed");
const commitBox = await page.locator("#commit").boundingBox();
check(
  "primary action is at least 44px tall",
  commitBox !== null && commitBox.height >= 44,
  commitBox ? `${Math.round(commitBox.height)}px` : "not found",
);
const overflow = await page.evaluate(
  () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
);
check("no horizontal overflow at 390px", overflow <= 1, `overflow ${overflow}px`);

// ---------------------------------------------------------------- 10. console
console.log("\n[10] Browser console");
const realErrors = consoleErrors.filter((e) => !/favicon|manifest|sw\.js/i.test(e));
check("no console/page errors", realErrors.length === 0, realErrors.slice(0, 2).join(" | "));


// ---------------------------------------------------------------- 11. secure context
console.log("\n[11] Insecure origins are diagnosed honestly, not as 'permission denied'");
{
  const { networkInterfaces } = await import("node:os");
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address;

  if (!lan) {
    console.log("  SKIP  no LAN address on this machine");
  } else {
    const insecure = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const ip = await insecure.newPage();
    try {
      await ip.goto(`http://${lan}:3002`, { waitUntil: "networkidle", timeout: 20000 });
      await ip.waitForTimeout(1000);

      const secure = await ip.evaluate(() => window.isSecureContext);
      check("LAN http really is an insecure context", secure === false);

      // Without this banner the collector is told they denied permission, goes
      // into phone settings, finds it granted, and has no way forward.
      const banner = await ip.locator('[role="alert"]').count();
      check("app warns that HTTPS is required", banner > 0);
      if (banner > 0) {
        const text = await ip.locator('[role="alert"]').first().innerText();
        check("the warning names HTTPS as the cause", /https/i.test(text));
        check("it does not blame the collector's permissions", !/permission denied/i.test(text));
      }
    } catch (error) {
      check("insecure-origin page loads", false, error.message.split("\n")[0]);
    } finally {
      await insecure.close();
    }
  }
}

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${"=".repeat(60)}`);
console.log(`CAPTURE PWA: ${results.length - failed.length}/${results.length} checks passed`);
for (const f of failed) console.log(`  FAILED: ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
process.exit(failed.length ? 1 : 0);
