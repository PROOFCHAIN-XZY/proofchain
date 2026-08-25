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
const { privateKeyFromPem, signWeighIn, verifyMerkleProof } = shared;


const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const BACKEND = process.env.BACKEND_URL ?? "http://localhost:3000";

const seed = JSON.parse(
  readFileSync(resolve(ROOT, "apps/backend/var/seed-devices.json"), "utf8"),
);

/** The hub is read from the API, never hardcoded. */
let hub = null;

function fakeJpeg() {
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(512)]);
}

/** A plausible weigh-in. */
function buildWeighIn(device, index) {
  const photoBytes = fakeJpeg();
  return {
    schema: "proofchain.weighin.v2",
    collectorId: device.collectorId,
    hubId: device.hubId,
    deviceId: device.deviceId,
    weightKg: Number((8 + Math.random() * 20).toFixed(3)),
    material: "PET",
    capturedAt: new Date(Date.now() - (index + 1) * 60_000).toISOString(),
    photoHash: createHash("sha256").update(photoBytes).digest("hex"),
    nonce: randomBytes(16).toString("hex"),
    // Carried alongside rather than inside the payload: the signature covers
    // the digest, never the bytes.
    photoBytes,
  };
}

/** Upload the photo the way a phone does — after the weigh-in is accepted. */
async function uploadPhoto(eventId, photoBytes) {
  const res = await fetch(`${BACKEND}/events/${eventId}/photo`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: photoBytes,
  });
  if (!res.ok) {
    throw new Error(`photo upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
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

  const hubs = await api("/hubs", { token: accessToken });
  hub = hubs.find((h) => h.id === seed.hubId) ?? hubs[0];
  if (!hub) throw new Error("no hubs found — run the seed first");

  console.log(`  hub ${hub.code}`);

  log("2/8", "Capturing signed weigh-ins from enrolled devices");
  const eventIds = [];
  let submitted = 0;
  let photosUploaded = 0;
  const failuresBeforeReport = [];

  for (let i = 0; i < 12; i++) {
    const device = seed.devices[i % seed.devices.length];
    const { photoBytes, ...payload } = buildWeighIn(device, i);
    const signature = signWeighIn(payload, privateKeyFromPem(device.privateKeyPem));

    const result = await api("/events", { method: "POST", body: { payload, signature } });
    submitted += 1;

    if (result.quarantined) {
      console.log(`  event ${i + 1}: QUARANTINED (${result.integrity.outcome})`);
    } else {
      eventIds.push(result.eventId);
      // Second request, as a field phone does it: the weigh-in is already safe
      // on the server before the megabytes are attempted.
      await uploadPhoto(result.eventId, photoBytes);
      photosUploaded += 1;
    }
  }
  console.log(`  ${eventIds.length}/${submitted} weigh-ins passed integrity v1`);
  console.log(`  ${photosUploaded} photos uploaded and hash-checked by the server`);

  // Prove the server refuses a substituted photo. This is the check that makes
  // the image evidence rather than decoration.
  const substituteTarget = eventIds[0];
  const substitution = await fetch(`${BACKEND}/events/${substituteTarget}/photo`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: fakeJpeg(),
  });
  console.log(
    `  substituted photo rejected: ${!substitution.ok} (HTTP ${substitution.status})`,
  );
  if (substitution.ok) failuresBeforeReport.push("server accepted a photo that was not signed");

  log("3/8", "Proving a tampered weigh-in is rejected");
  {
    const device = seed.devices[0];
    const { photoBytes: _unusedPhoto, ...honest } = buildWeighIn(device, 99);
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

  // Before anchoring, prove the failure path is wired: report an attempt that
  // produced nothing and check the backend holds it back rather than handing
  // the batch straight back to the worker.
  const beforeBackoff = await api("/batches/pending-anchor");
  const queuedBefore = beforeBackoff.some((b) => b.id === batch.id);

  await api(`/batches/${batch.id}/anchor-failure`, {
    method: "POST",
    body: { outcome: "failed", detail: "demo: simulated Horizon timeout" },
    headers: { "x-anchor-worker-token": process.env.ANCHOR_WORKER_TOKEN ?? "" },
  });

  const afterBackoff = await api("/batches/pending-anchor");
  const queuedAfter = afterBackoff.some((b) => b.id === batch.id);
  console.log(`  failure recorded; batch withheld from the queue: ${queuedBefore && !queuedAfter}`);
  if (!queuedBefore) failuresBeforeReport.push("sealed batch never entered the anchor queue");
  if (queuedAfter) failuresBeforeReport.push("a failed batch was offered again immediately");

  const health = await api("/batches/anchor-health", { token: accessToken });
  const awaiting = health.batches.find((b) => b.batchId === batch.id);
  console.log(
    `  anchor health   : ${health.awaitingAnchor} awaiting, ${health.stuck} stuck ` +
      `(this batch: ${awaiting?.failedAttempts ?? 0} failed, next ${awaiting?.nextAttemptAt ?? "now"})`,
  );
  if (!awaiting || awaiting.failedAttempts !== 1) {
    failuresBeforeReport.push("anchor health did not report the recorded failure");
  }

  // The worker is invoked directly below, so it anchors regardless of the
  // backoff the queue is applying — which is what makes the recovery visible.
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

  // The failure must survive the recovery: "anchored after one failure" is a
  // different operational fact from "anchored first time".
  const healthAfter = await api("/batches/anchor-health", { token: accessToken });
  const stillAwaiting = healthAfter.batches.some((b) => b.batchId === batch.id);
  console.log(`  batch left the anchor queue after anchoring: ${!stillAwaiting}`);
  if (stillAwaiting) failuresBeforeReport.push("anchored batch is still listed as awaiting anchor");

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

  const failures = [...failuresBeforeReport];

  // Every clean event should carry retrievable, hash-checked photo evidence.
  const withoutPhotos = report.events.filter((e) => !e.photoAvailable);
  console.log(
    `  photo evidence  : ${report.events.length - withoutPhotos.length}/${report.events.length} events`,
  );
  if (withoutPhotos.length > 0) failures.push(`${withoutPhotos.length} events have no photo stored`);

  // And the bytes served back must still hash to what the device signed.
  const photoResponse = await fetch(`${BACKEND}${report.events[0].photoUrl}`);
  const servedPhoto = Buffer.from(await photoResponse.arrayBuffer());
  const servedHash = createHash("sha256").update(servedPhoto).digest("hex");
  console.log(`  photo round-trip: ${servedHash === report.events[0].photoHash}`);
  if (servedHash !== report.events[0].photoHash) {
    failures.push("served photo does not hash to the signed photoHash");
  }
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
