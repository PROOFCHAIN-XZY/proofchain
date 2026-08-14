/**
 * End-to-end demo: weigh-in -> batch -> seal -> Stellar anchor -> audit report.
 *
 * Acts as a real enrolled collector device: it signs each weigh-in with the
 * ed25519 private key written by the seed script, so every server-side integrity
 * check runs exactly as it would in the field.
 *
 *   node scripts/demo-e2e.mjs
 *
 * Requires: backend running on :3000, database seeded, anchor worker built and
 * STELLAR_SECRET funded on testnet.
 */

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);
const shared = require("@proofchain/shared");
const { privateKeyFromPem, signWeighIn, verifyMerkleProof, haversineMetres } = shared;

const formatKm = (m) => (m >= 1000 ? `${(m / 1000).toFixed(0)} km` : `${Math.round(m)} m`);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const BACKEND = process.env.BACKEND_URL ?? "http://localhost:3000";

const seed = JSON.parse(
  readFileSync(resolve(ROOT, "apps/backend/var/seed-devices.json"), "utf8"),
);

/**
 * The hub is read from the API, never hardcoded.
 *
 * A fixed coordinate here silently breaks the moment the hub moves — every
 * weigh-in lands outside the geofence and is quarantined, and the demo reports
 * "0/12 passed integrity" without saying why. Reading it means the demo works
 * wherever the hub actually is, including after `npm run hub:relocate`.
 */
let hub = null;

/** Metres to degrees, so the jitter scales with the hub's own fence. */
function metresToDegrees(metres, atLatitude) {
  const lat = metres / 111_320;
  const lng = metres / (111_320 * Math.cos((atLatitude * Math.PI) / 180));
  return { lat, lng };
}

/**
 * Where is the operator running this demo?
 *
 * There is no GPS on a laptop, so this resolves an approximate position from the
 * public IP. It is city-accurate at best, which is fine for its only purpose:
 * putting the hub somewhere the demo can plausibly claim weigh-ins happened.
 *
 * IMPORTANT — what this costs. Moving the hub to the operator makes the server's
 * `geofence_ok` check pass by construction. That check exists to prove a
 * collector stood at the hub; once the hub follows them, it proves nothing. The
 * demo therefore says so out loud rather than presenting a self-satisfied check
 * as evidence. The tamper detection in step 3 is unaffected — it defeats a
 * forged signature and an inflated weight, neither of which depends on location.
 *
 * Set DEMO_LOCATION=hub to keep the seeded hub (offline runs, CI, or when you
 * want the geofence to mean something).
 */
async function resolveOperatorLocation() {
  if (process.env.DEMO_LOCATION === "hub") return null;

  const lat = Number(process.env.DEMO_LAT);
  const lng = Number(process.env.DEMO_LNG);
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return { lat, lng, label: "DEMO_LAT/DEMO_LNG", source: "env" };
  }

  try {
    // Overridable so the offline path is testable, and so an air-gapped setup
    // can point at its own service instead of a public one.
    const endpoint =
      process.env.DEMO_GEOIP_URL ?? "http://ip-api.com/json/?fields=status,country,city,lat,lon";
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(6000) });
    const data = await res.json();
    if (data.status !== "success") throw new Error(data.message ?? "lookup failed");
    return {
      lat: data.lat,
      lng: data.lon,
      label: `${data.city}, ${data.country}`,
      source: "ip",
    };
  } catch (error) {
    // Never fail the demo over this: fall back to the hub already configured.
    console.log(`  could not resolve your location (${error.message}); using the seeded hub`);
    return null;
  }
}

/** Moves the hub via the dev-only script, which refuses to run in production. */
function relocateHub(lat, lng, radiusM, code) {
  execFileSync(
    "npx",
    [
      "ts-node",
      "-r",
      "tsconfig-paths/register",
      "src/database/relocate-hub.ts",
      String(lat),
      String(lng),
      String(radiusM),
      code,
    ],
    { cwd: resolve(ROOT, "apps/backend"), encoding: "utf8", stdio: "pipe" },
  );
}

function log(step, message) {
  console.log(`\n\x1b[36m[${step}]\x1b[0m ${message}`);
}

/**
 * Anchoring blocks this process for several seconds, long enough for the server
 * to close an idle keep-alive socket. The pooled connection then looks usable but
 * is already gone, and the next request fails at the transport layer before any
 * HTTP status exists. Retry transport failures; never retry an HTTP error, since
 * those are real answers about the state of the system.
 */
async function fetchWithRetry(url, init, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((r) => setTimeout(r, 250 * attempt));
    }
  }
}

async function api(path, { method = "GET", token, body } = {}) {
  const res = await fetchWithRetry(`${BACKEND}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    // A fresh connection per request keeps a long synchronous step from
    // poisoning the pool.
    keepalive: false,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  // Parse arrays as well as objects: list endpoints such as /hubs return `[...]`,
  // and treating those as plain text silently yields a string that fails later
  // with something unhelpful like "hubs.find is not a function".
  const trimmed = text.trim();
  const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  const data = text && looksJson ? JSON.parse(text) : text;

  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  }
  return data;
}

/** A plausible weigh-in, jittered inside the hub geofence. */
function buildWeighIn(device, index) {
  const photoBytes = randomBytes(64);
  const jitter = metresToDegrees(hub.geofenceRadiusM * 0.5, hub.lat);
  return {
    schema: "proofchain.weighin.v1",
    collectorId: device.collectorId,
    hubId: device.hubId,
    deviceId: device.deviceId,
    weightKg: Number((8 + Math.random() * 20).toFixed(3)),
    material: "PET",
    // Jitter to a quarter of the fence, so weigh-ins scatter realistically
    // around the hub while staying comfortably inside it.
    lat: Number((hub.lat + (Math.random() - 0.5) * jitter.lat).toFixed(6)),
    lng: Number((hub.lng + (Math.random() - 0.5) * jitter.lng).toFixed(6)),
    capturedAt: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
    photoHash: createHash("sha256").update(photoBytes).digest("hex"),
    nonce: randomBytes(16).toString("hex"),
  };
}

/** null is "we could not ask", which is not the same as "no". */
function describeTriState(value) {
  if (value === true) return "confirmed";
  if (value === false) return "NOT ON CHAIN";
  return "unchecked (Horizon unreachable)";
}

function describeLedger(confirmation) {
  if (!confirmation) return "no anchor to check";
  const detail = `memo=${confirmation.memoMatches} dataEntry=${confirmation.dataEntryMatches}`;
  return `${describeTriState(confirmation.rootMatchesLedger)} (${detail})`;
}

async function main() {
  log("1/8", "Authenticating as the hub operator");
  const { accessToken, role } = await api("/auth/login", {
    method: "POST",
    body: { email: "operator@proofchain.local", password: "operator-dev-password" },
  });
  console.log(`  logged in as ${role}`);

  let hubs = await api("/hubs", { token: accessToken });
  hub = hubs.find((h) => h.id === seed.hubId) ?? hubs[0];
  if (!hub) throw new Error("no hubs found — run the seed first");

  const here = await resolveOperatorLocation();
  if (here) {
    const away = haversineMetres(here.lat, here.lng, hub.lat, hub.lng);
    if (away > hub.geofenceRadiusM) {
      console.log(
        `  you are ${formatKm(away)} from ${hub.code}; moving the hub to ${here.label}`,
      );
      relocateHub(here.lat, here.lng, hub.geofenceRadiusM, hub.code);
      hubs = await api("/hubs", { token: accessToken });
      hub = hubs.find((h) => h.id === hub.id) ?? hubs[0];
      console.log(
        `  \x1b[33mnote:\x1b[0m the hub now sits where you are, so the geofence check ` +
          `passes by construction and proves nothing on this run.`,
      );
    }
  }

  console.log(`  hub ${hub.code} at ${hub.lat}, ${hub.lng} (fence ${hub.geofenceRadiusM} m)`);

  log("2/8", "Capturing signed weigh-ins from enrolled devices");
  const eventIds = [];
  let submitted = 0;

  for (let i = 0; i < 12; i++) {
    const device = seed.devices[i % seed.devices.length];
    const payload = buildWeighIn(device, i);
    const signature = signWeighIn(payload, privateKeyFromPem(device.privateKeyPem));

    const result = await api("/events", { method: "POST", body: { payload, signature } });
    submitted += 1;

    if (result.quarantined) {
      console.log(`  event ${i + 1}: QUARANTINED (${result.integrity.outcome})`);
    } else {
      eventIds.push(result.eventId);
    }
  }
  console.log(`  ${eventIds.length}/${submitted} weigh-ins passed integrity v1`);

  log("3/8", "Proving a tampered weigh-in is rejected");
  {
    const device = seed.devices[0];
    const honest = buildWeighIn(device, 99);
    const signature = signWeighIn(honest, privateKeyFromPem(device.privateKeyPem));
    const inflated = { ...honest, weightKg: 950 }; // signed 8-28 kg, claims 950

    const result = await api("/events", {
      method: "POST",
      body: { payload: inflated, signature },
    });
    const failed = result.integrity.findings
      .filter((f) => f.outcome === "fail")
      .map((f) => f.check);
    console.log(
      `  inflated weigh-in quarantined=${result.quarantined}; failed checks: ${failed.join(", ")}`,
    );
    if (!result.quarantined) throw new Error("SECURITY: a tampered weigh-in was accepted");
  }

  log("4/8", "Opening a batch and adding the clean events");
  const batch = await api("/batches", {
    method: "POST",
    token: accessToken,
    body: { hubId: seed.hubId, material: "PET" },
  });
  await api(`/batches/${batch.id}/events`, {
    method: "POST",
    token: accessToken,
    body: { eventIds },
  });
  console.log(`  batch ${batch.id}`);

  log("5/8", "Sealing the batch (membership and Merkle root freeze here)");
  const sealed = await api(`/batches/${batch.id}/seal`, {
    method: "POST",
    token: accessToken,
  });
  console.log(`  root      : ${sealed.merkleRoot}`);
  console.log(`  weight    : ${sealed.totalWeightKg} kg across ${sealed.eventCount} weigh-ins`);

  log("6/8", "Recording chain of custody with reconciliation");
  await api(`/batches/${batch.id}/custody`, {
    method: "POST",
    token: accessToken,
    body: {
      fromParty: "Nairobi Pilot Hub",
      toParty: "Mr. Green Africa (processor)",
      weightInKg: Number(sealed.totalWeightKg),
      weightOutKg: Number((Number(sealed.totalWeightKg) - 1.4).toFixed(3)),
      reason: "moisture loss and contamination rejects at intake",
      transferredAt: new Date().toISOString(),
    },
  });
  console.log("  custody transfer recorded");

  log("7/8", "Anchoring the root on Stellar testnet");
  const workerOutput = execFileSync(
    process.execPath,
    [
      "-e",
      `require("dotenv").config({path:"${resolve(ROOT, "services/anchor-worker/.env")}"});` +
        `require("${resolve(ROOT, "services/anchor-worker/dist/index.js")}").anchorOnce()` +
        `.then(n=>console.log("anchored "+n+" batch(es)")).catch(e=>{console.error(e);process.exit(1)})`,
    ],
    { cwd: resolve(ROOT, "services/anchor-worker"), encoding: "utf8" },
  );
  console.log(workerOutput.trim().split("\n").map((l) => `  ${l}`).join("\n"));

  log("8/8", "Fetching the audit artifact and verifying it independently");
  const report = await api(`/batches/${batch.id}/report`);

  console.log(`  report version   : ${report.reportVersion}`);
  console.log(`  tonnes           : ${report.batch.totalWeightTonnes}`);
  console.log(`  sealed root      : ${report.proof.merkleRoot}`);
  console.log(`  recomputed root  : ${report.proof.recomputedRoot}`);
  console.log(`  roots agree      : ${report.proof.rootMatchesSealedValue}`);
  console.log(`  all proofs valid : ${report.proof.allProofsValid}`);
  console.log(`  reconciliation   : gap ${report.reconciliation.gapKg} kg (${report.reconciliation.gapPct}%)`);

  if (report.onChain) {
    console.log(`  stellar tx       : ${report.onChain.stellarTxHash}`);
    console.log(`  ledger           : ${report.onChain.stellarLedger}`);
    console.log(`  explorer         : ${report.onChain.explorerUrl}`);
    console.log(`  ledger says      : ${describeLedger(report.onChain.ledgerConfirmation)}`);
  } else {
    console.log("  stellar tx       : NOT ANCHORED");
  }

  // The check a buyer would run: recompute one event's proof themselves.
  const sample = report.events[0];
  const independent = verifyMerkleProof(sample.leaf, sample.merkleProof, report.proof.recomputedRoot);
  console.log(`  independent proof check on event ${sample.eventId}: ${independent}`);

  const verify = await api(`/batches/${batch.id}/verify/${sample.eventId}`);
  console.log(`  verify endpoint agrees: ${verify.proofValid}`);
  console.log(`  root matches ledger   : ${describeTriState(verify.onChain?.rootMatchesLedger)}`);

  // The batch-level read-back, which is what an auditor checking many events
  // in one batch would call once instead of per event.
  const ledger = await api(`/batches/${batch.id}/ledger`);
  console.log(`  ledger endpoint       : ${describeLedger(ledger.confirmation)}`);

  const failures = [];
  if (!report.proof.rootMatchesSealedValue) failures.push("recomputed root != sealed root");
  if (!report.proof.allProofsValid) failures.push("some Merkle proofs invalid");
  if (!independent) failures.push("independent proof check failed");
  if (!report.onChain) failures.push("batch was not anchored on Stellar");

  // Deliberately fails only on an explicit contradiction. A null means Horizon
  // was unreachable from this machine, which is a network fact and must not
  // turn a working pipeline into a red demo.
  if (report.onChain?.ledgerConfirmation?.rootMatchesLedger === false) {
    failures.push("Horizon does not carry the sealed root for this batch");
  }
  if (ledger.confirmation?.rootMatchesLedger === false) {
    failures.push("batch ledger endpoint reports the root is not on chain");
  }

  if (failures.length > 0) {
    console.error(`\n\x1b[31mDEMO FAILED:\x1b[0m ${failures.join("; ")}`);
    process.exit(1);
  }

  console.log(`\n\x1b[32mEnd-to-end verified.\x1b[0m batch=${batch.id}`);
  console.log(`Audit report : ${BACKEND}/batches/${batch.id}/report`);
  console.log(`Event CSV    : ${BACKEND}/batches/${batch.id}/report/events.csv`);
}

main().catch((error) => {
  console.error("\ndemo failed:", error.message);
  process.exit(1);
});
