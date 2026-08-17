import type { AttemptSummary } from "./anchor-attempts.service";

/**
 * When a failing batch may be tried again.
 *
 * The worker polls every 15 seconds and, before this existed, re-attempted
 * every pending batch on every pass. A batch failing for a structural reason —
 * an unfunded account, a root the network rejects, a misconfigured passphrase —
 * was therefore retried roughly six thousand times a day, none of which could
 * ever succeed, while filling the logs that a real incident would need to be
 * visible in.
 *
 * Deliberately pure and deliberately not jittered: the retry population here is
 * a handful of batches on a single worker, so there is no thundering herd to
 * spread out, and a deterministic schedule is one an operator can predict from
 * the attempt count alone.
 */

/** First retry waits this long after one failure. */
const BASE_DELAY_MS = 30_000;

/**
 * Ceiling on the wait. An hour is short enough that a batch recovers on its own
 * once a transient upstream problem clears, and long enough that a permanently
 * broken batch costs 24 attempts a day rather than 5,760.
 */
const MAX_DELAY_MS = 60 * 60 * 1000;

/**
 * Consecutive failures after which a batch is called stuck.
 *
 * Six failures spans roughly half an hour of backoff, which is well past any
 * plausible Horizon blip. Past that point the honest reading is that something
 * needs a person, and the operator view says so rather than showing a batch
 * that looks merely slow.
 */
export const STUCK_AFTER_FAILURES = 6;

export function backoffDelayMs(failures: number): number {
  if (failures <= 0) return 0;
  // 30s, 60s, 2m, 4m, 8m, 16m, 32m, then capped at 1h.
  const exponential = BASE_DELAY_MS * 2 ** (failures - 1);
  return Math.min(exponential, MAX_DELAY_MS);
}

/** The earliest a batch with this history should be attempted again. */
export function nextAttemptAt(summary: AttemptSummary | undefined): Date | null {
  // Never attempted, or last attempt succeeded and left the batch here for
  // some other reason: nothing to wait for.
  if (!summary || summary.failures === 0 || !summary.lastAttemptAt) return null;
  if (summary.lastOutcome === "succeeded") return null;

  return new Date(summary.lastAttemptAt.getTime() + backoffDelayMs(summary.failures));
}

export function isDueForRetry(summary: AttemptSummary | undefined, now = new Date()): boolean {
  const next = nextAttemptAt(summary);
  return next === null || next.getTime() <= now.getTime();
}

export function isStuck(summary: AttemptSummary | undefined): boolean {
  return (summary?.failures ?? 0) >= STUCK_AFTER_FAILURES;
}
