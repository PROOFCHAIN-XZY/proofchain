import { describe, expect, it } from "vitest";
import type { AttemptSummary } from "../src/batches/anchor-attempts.service";
import {
  backoffDelayMs,
  isDueForRetry,
  isStuck,
  nextAttemptAt,
  STUCK_AFTER_FAILURES,
} from "../src/batches/anchor-backoff";

/**
 * Pure schedule arithmetic. Worth pinning precisely because the numbers decide
 * how long a transient failure delays a real anchor, and how much a permanent
 * one costs in wasted attempts.
 */

const AT = new Date("2026-03-01T12:00:00.000Z");

function summary(over: Partial<AttemptSummary> = {}): AttemptSummary {
  return {
    batchId: "batch-1",
    attempts: 1,
    failures: 1,
    lastOutcome: "failed",
    lastAttemptAt: AT,
    lastDetail: null,
    ...over,
  };
}

describe("backoffDelayMs", () => {
  it("doubles from thirty seconds", () => {
    expect(backoffDelayMs(1)).toBe(30_000);
    expect(backoffDelayMs(2)).toBe(60_000);
    expect(backoffDelayMs(3)).toBe(120_000);
    expect(backoffDelayMs(4)).toBe(240_000);
  });

  it("caps at an hour", () => {
    // Bounded so a batch still recovers on its own once a transient upstream
    // problem clears, instead of waiting days because it failed all night.
    expect(backoffDelayMs(20)).toBe(3_600_000);
    expect(backoffDelayMs(200)).toBe(3_600_000);
  });

  it("does not delay a batch that has never failed", () => {
    expect(backoffDelayMs(0)).toBe(0);
    expect(backoffDelayMs(-1)).toBe(0);
  });
});

describe("nextAttemptAt", () => {
  it("schedules from the last attempt, not from now", () => {
    // Anchored to the attempt so a restarted worker does not reset every
    // batch's backoff to zero and start the storm again.
    expect(nextAttemptAt(summary({ failures: 2 }))).toEqual(new Date(AT.getTime() + 60_000));
  });

  it("returns null for a batch with no attempt history", () => {
    expect(nextAttemptAt(undefined)).toBeNull();
  });

  it("returns null once the last attempt succeeded", () => {
    expect(
      nextAttemptAt(summary({ attempts: 3, failures: 2, lastOutcome: "succeeded" })),
    ).toBeNull();
  });
});

describe("isDueForRetry", () => {
  it("holds a batch back until its delay has passed", () => {
    const s = summary({ failures: 3 }); // 2 minutes
    expect(isDueForRetry(s, new Date(AT.getTime() + 60_000))).toBe(false);
    expect(isDueForRetry(s, new Date(AT.getTime() + 120_000))).toBe(true);
  });

  it("lets a never-attempted batch through immediately", () => {
    // A freshly sealed batch must anchor now, not in thirty seconds.
    expect(isDueForRetry(undefined, AT)).toBe(true);
  });

  it("treats an unverified attempt as needing backoff", () => {
    // Submitted but unconfirmed: retrying at once risks paying a second fee
    // for a transaction that may be about to appear.
    const s = summary({ lastOutcome: "unverified" });
    expect(isDueForRetry(s, new Date(AT.getTime() + 1_000))).toBe(false);
  });
});

describe("isStuck", () => {
  it("flags a batch only after repeated failure", () => {
    expect(isStuck(summary({ failures: STUCK_AFTER_FAILURES - 1 }))).toBe(false);
    expect(isStuck(summary({ failures: STUCK_AFTER_FAILURES }))).toBe(true);
  });

  it("does not flag a batch that has never been attempted", () => {
    expect(isStuck(undefined)).toBe(false);
  });
});
