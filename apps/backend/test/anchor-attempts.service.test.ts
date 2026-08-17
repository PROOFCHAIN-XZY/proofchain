import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AnchorAttemptsService } from "../src/batches/anchor-attempts.service";
import { AnchorAttemptEntity, BatchEntity } from "../src/database/entities";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { seedHub, type SeededHub } from "./support/fixtures";

/**
 * The history of what anchoring tried. Its value is entirely in being visible
 * to something other than a log reader, so the tests are about what a caller
 * can learn from it.
 */

let db: TestDatabase;
let service: AnchorAttemptsService;
let seeded: SeededHub;

async function batch(): Promise<string> {
  const row = await db.dataSource.getRepository(BatchEntity).save({
    hubId: seeded.hub.id,
    material: "PET",
    status: "sealed",
    totalWeightKg: 10,
    eventCount: 1,
    merkleRoot: "a".repeat(64),
    sealedAt: new Date(),
  } as BatchEntity);
  return row.id;
}

beforeEach(async () => {
  db ??= await createTestDatabase();
  await db.reset();
  service = new AnchorAttemptsService(
    db.dataSource.getRepository(AnchorAttemptEntity),
    db.dataSource,
  );
  seeded = await seedHub(db.dataSource);
});

afterAll(async () => {
  await db?.close();
});

describe("AnchorAttemptsService.record", () => {
  it("numbers attempts from one, per batch", async () => {
    const first = await batch();
    const second = await batch();

    expect((await service.record(first, { outcome: "failed" })).attemptNumber).toBe(1);
    expect((await service.record(first, { outcome: "failed" })).attemptNumber).toBe(2);
    // Numbering is per batch, not global: "attempt 2" must mean this batch has
    // been tried twice, not that the worker has failed twice overall.
    expect((await service.record(second, { outcome: "failed" })).attemptNumber).toBe(1);
  });

  it("keeps the error text an operator will debug from", async () => {
    const id = await batch();

    const attempt = await service.record(id, {
      outcome: "failed",
      detail: "tx_insufficient_fee: base fee 100 below current network minimum",
    });

    expect(attempt.detail).toContain("tx_insufficient_fee");
  });

  it("truncates a pathological error rather than storing it whole", async () => {
    const id = await batch();

    const attempt = await service.record(id, { outcome: "failed", detail: "x".repeat(50_000) });

    expect(attempt.detail!.length).toBe(2_000);
  });

  it("keeps the transaction hash for an unverified attempt", async () => {
    const id = await batch();

    const attempt = await service.record(id, {
      outcome: "unverified",
      stellarTxHash: "d".repeat(64),
      detail: "memo did not match on read-back",
    });

    // The hash is the whole point of this outcome: it may have cost a real fee
    // and it is what an operator pastes into an explorer.
    expect(attempt.outcome).toBe("unverified");
    expect(attempt.stellarTxHash).toBe("d".repeat(64));
  });

  it("records successes too", async () => {
    const id = await batch();
    await service.record(id, { outcome: "failed", detail: "horizon 504" });
    await service.record(id, { outcome: "succeeded" });

    const history = await service.historyFor(id);

    // A batch that eventually anchored after four failures is a different
    // operational story from one that anchored first time, and the table is
    // the only place that story survives.
    expect(history.map((a) => a.outcome)).toEqual(["succeeded", "failed"]);
  });
});

describe("AnchorAttemptsService.summariesFor", () => {
  it("counts attempts and reports the most recent outcome", async () => {
    const id = await batch();
    await service.record(id, { outcome: "failed", detail: "first" });
    await service.record(id, { outcome: "unverified", detail: "second" });

    const summary = (await service.summariesFor([id])).get(id)!;

    expect(summary.attempts).toBe(2);
    expect(summary.failures).toBe(2);
    expect(summary.lastOutcome).toBe("unverified");
    expect(summary.lastDetail).toBe("second");
  });

  it("does not count a success as a failure", async () => {
    const id = await batch();
    await service.record(id, { outcome: "failed" });
    await service.record(id, { outcome: "succeeded" });

    const summary = (await service.summariesFor([id])).get(id)!;

    expect(summary.attempts).toBe(2);
    expect(summary.failures).toBe(1);
    expect(summary.lastOutcome).toBe("succeeded");
  });

  it("summarises many batches in one call", async () => {
    const [a, b] = [await batch(), await batch()];
    await service.record(a, { outcome: "failed" });
    await service.record(b, { outcome: "failed" });
    await service.record(b, { outcome: "failed" });

    const summaries = await service.summariesFor([a, b]);

    expect(summaries.get(a)!.attempts).toBe(1);
    expect(summaries.get(b)!.attempts).toBe(2);
  });

  it("omits batches that have never been attempted", async () => {
    const id = await batch();

    // Absent rather than a zeroed row: "never tried" and "tried and failed
    // zero times" would otherwise be the same value.
    expect((await service.summariesFor([id])).has(id)).toBe(false);
    expect((await service.summariesFor([])).size).toBe(0);
  });
});
