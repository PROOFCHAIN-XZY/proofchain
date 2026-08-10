import { config as loadDotenv } from "dotenv";
import { Keypair } from "@stellar/stellar-sdk";
import { anchorBatchRoot, loadAnchorConfig, verifyAnchorOnLedger } from "./anchor";

loadDotenv();

/**
 * Worker entrypoint: poll the backend for sealed-but-unanchored batches, anchor
 * each root on Stellar, verify it back off the ledger, then record the result.
 *
 * Polling rather than a queue consumer is deliberate for the MVP: it has no
 * broker dependency and recovers from a crash by simply asking again. The
 * backend's `pending-anchor` query is the single source of truth about what
 * still needs anchoring, so a lost message cannot silently drop a batch.
 */

const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:3000";
const POLL_MS = Number(process.env.POLL_MS ?? 15_000);

/**
 * Shared secret authorising the anchor write-back.
 *
 * `POST /batches/:id/anchor` is the endpoint that records "this root is on
 * chain, at this transaction". Left open, anyone could read a sealed root from
 * the public audit report and post it back with a fabricated transaction hash,
 * and the forged proof would then appear in the report sold to a credit buyer.
 * The worker is headless, so it authenticates with a shared token rather than a
 * human JWT.
 */
const ANCHOR_WORKER_TOKEN = process.env.ANCHOR_WORKER_TOKEN ?? "";

/**
 * A hung backend or Horizon request must never wedge the poll loop forever —
 * that would silently stop all future anchoring with no error, no crash, and
 * no log signal beyond "nothing is happening". Every network call the worker
 * makes is therefore bounded.
 */
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS ?? 20_000);
const ANCHOR_TIMEOUT_MS = Number(process.env.ANCHOR_TIMEOUT_MS ?? 60_000);

interface PendingBatch {
  id: string;
  merkleRoot: string;
  totalWeightKg: number;
  eventCount: number;
}

/** Never assume a caught value is an Error — fetch/AbortSignal/SDK code can throw anything. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Rejects if `promise` has not settled within `ms` — never hangs silently. */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function fetchPending(): Promise<PendingBatch[]> {
  const res = await fetch(`${BACKEND_URL}/batches/pending-anchor`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`backend returned ${res.status} for pending-anchor`);
  }
  return (await res.json()) as PendingBatch[];
}

async function recordAnchor(batchId: string, body: unknown): Promise<void> {
  const res = await fetch(`${BACKEND_URL}/batches/${batchId}/anchor`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-anchor-worker-token": ANCHOR_WORKER_TOKEN,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (res.status === 401 || res.status === 403) {
    // Distinguish "misconfigured" from "backend refused this particular anchor":
    // the root is already on-chain by this point, and retrying forever against a
    // token mismatch would hide the real problem behind anchor-failed noise.
    throw new Error(
      `backend rejected the anchor write-back as unauthorised (${res.status}). ` +
        `ANCHOR_WORKER_TOKEN must match the backend's value.`,
    );
  }
  if (!res.ok) {
    throw new Error(`backend rejected the anchor record (${res.status}): ${await res.text()}`);
  }
}

export async function anchorOnce(): Promise<number> {
  // Checked before any ledger work: anchoring first and discovering the
  // write-back is unauthorised afterwards would burn a real (paid) Stellar
  // transaction and leave the batch looking unanchored, so it would be anchored
  // again on the next cycle.
  if (!ANCHOR_WORKER_TOKEN) {
    throw new Error(
      "ANCHOR_WORKER_TOKEN is not set — the backend will reject the anchor write-back. " +
        "Set it in services/anchor-worker/.env to match the backend's value.",
    );
  }

  const config = loadAnchorConfig();
  const publicKey = Keypair.fromSecret(config.secret).publicKey();
  const pending = await fetchPending();

  let anchored = 0;

  for (const batch of pending) {
    try {
      const result = await withTimeout(
        anchorBatchRoot(batch.merkleRoot, batch.id, config),
        ANCHOR_TIMEOUT_MS,
        `anchoring batch ${batch.id}`,
      );

      const verification = await withTimeout(
        verifyAnchorOnLedger(
          result.stellarTxHash,
          batch.merkleRoot,
          publicKey,
          result.dataEntryKey,
          config,
        ),
        ANCHOR_TIMEOUT_MS,
        `verifying batch ${batch.id}`,
      );

      if (!verification.verified) {
        // Do not record an anchor we cannot independently confirm. The batch
        // stays pending and will be retried rather than gaining a false proof.
        console.error(
          `[unverified] batch=${batch.id} tx=${result.stellarTxHash} ` +
            `memo=${verification.memoMatches} data=${verification.dataEntryMatches} — not recording`,
        );
        continue;
      }

      await recordAnchor(batch.id, {
        merkleRoot: batch.merkleRoot,
        stellarTxHash: result.stellarTxHash,
        stellarLedger: verification.ledger ?? result.stellarLedger,
        network: result.network,
        dataEntryKey: result.dataEntryKey,
        anchoredAt: result.anchoredAt,
      });

      anchored += 1;
      console.log(
        `[anchored] batch=${batch.id} weight=${batch.totalWeightKg}kg events=${batch.eventCount} ` +
          `tx=${result.stellarTxHash} ledger=${verification.ledger ?? result.stellarLedger}`,
      );
    } catch (error) {
      // One bad batch must not stall the queue behind it.
      console.error(`[anchor-failed] batch=${batch.id}:`, errorMessage(error));
    }
  }

  return anchored;
}

async function main(): Promise<void> {
  console.log(`anchor-worker up. backend=${BACKEND_URL} poll=${POLL_MS}ms`);

  let running = true;
  const stop = (signal: string) => {
    console.log(`received ${signal}, finishing current cycle then exiting`);
    running = false;
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  while (running) {
    await anchorOnce().catch((error) => {
      console.error("cycle error:", errorMessage(error));
    });
    if (!running) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  process.exit(0);
}

if (require.main === module) {
  void main();
}
