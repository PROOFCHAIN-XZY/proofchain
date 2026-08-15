import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import type { DataSource } from "typeorm";
import { hashLeaf, merkleRootHex, verifyMerkleProof } from "@proofchain/shared";
import { BatchesService } from "../../src/batches/batches.service";
import {
  AnchorRecordEntity,
  BatchEntity,
  CollectionEventEntity,
} from "../../src/database/entities";
import { createTestDataSource, resetTables } from "./database";
import { at, insertEvent, seedFixtures, type Fixtures } from "./fixtures";

/**
 * Sealing is the hinge of the product. Before it a batch is a mutable working
 * set; after it, membership and the Merkle root are frozen and that root goes
 * to a public ledger where it cannot be taken back. Every proof ever handed to
 * a buyer depends on this transition being irreversible and reproducible.
 *
 * So these tests are written from the position of the person who does not
 * trust us: they recompute the root independently from the event rows and
 * compare, rather than checking that seal() agrees with itself.
 */

let dataSource: DataSource;
let service: BatchesService;
let fixtures: Fixtures;

beforeAll(async () => {
  dataSource = await createTestDataSource();
}, 60_000);

afterAll(async () => {
  await dataSource?.destroy();
});

beforeEach(async () => {
  await resetTables(dataSource);
  fixtures = await seedFixtures(dataSource);
  service = new BatchesService(
    dataSource.getRepository(BatchEntity),
    dataSource.getRepository(CollectionEventEntity),
    dataSource.getRepository(AnchorRecordEntity),
    dataSource,
  );
});

/**
 * The root a third party would compute from the same events, using only what
 * the audit report tells them: hash each payloadHash into a leaf, in
 * capturedAt-then-id order. Deliberately does not call anything in
 * BatchesService — a shared helper would let one bug hide in both places.
 */
async function independentlyRecomputedRoot(batchId: string): Promise<string> {
  const rows = await dataSource.getRepository(CollectionEventEntity).find({ where: { batchId } });
  const ordered = [...rows].sort((a, b) => {
    const byTime = a.capturedAt.getTime() - b.capturedAt.getTime();
    return byTime !== 0 ? byTime : a.id.localeCompare(b.id);
  });
  return merkleRootHex(ordered.map((e) => hashLeaf(e.payloadHash)));
}

describe("BatchesService — building a batch", () => {
  it("adds eligible events and recomputes the running totals", async () => {
    const batch = await service.create(fixtures.hub.id, "PET");
    const first = await insertEvent(dataSource, fixtures, { capturedAt: at(0), weightKg: 12.5 });
    const second = await insertEvent(dataSource, fixtures, { capturedAt: at(5), weightKg: 7.25 });

    const updated = await service.addEvents(batch.id, [first.id, second.id]);

    expect(updated.eventCount).toBe(2);
    expect(Number(updated.totalWeightKg)).toBe(19.75);
  });

  it("refuses a quarantined event — a failed check must never reach a credit", async () => {
    const batch = await service.create(fixtures.hub.id, "PET");
    const clean = await insertEvent(dataSource, fixtures, { capturedAt: at(0) });
    const dirty = await insertEvent(dataSource, fixtures, {
      capturedAt: at(1),
      quarantined: true,
    });

    await expect(service.addEvents(batch.id, [clean.id, dirty.id])).rejects.toThrow(
      BadRequestException,
    );
  });

  it("rejects the whole call rather than adding the eligible half", async () => {
    // Partial success would leave the operator believing the batch holds events
    // it does not, which is discovered at seal time — after the totals have
    // already been reported.
    const batch = await service.create(fixtures.hub.id, "PET");
    const clean = await insertEvent(dataSource, fixtures, { capturedAt: at(0) });
    const dirty = await insertEvent(dataSource, fixtures, {
      capturedAt: at(1),
      quarantined: true,
    });

    await expect(service.addEvents(batch.id, [clean.id, dirty.id])).rejects.toThrow();

    const reloaded = await service.findOne(batch.id);
    expect(reloaded.eventCount).toBe(0);
    const stillFree = await dataSource
      .getRepository(CollectionEventEntity)
      .findOneOrFail({ where: { id: clean.id } });
    expect(stillFree.batchId).toBeNull();
  });

  it("refuses an event that already belongs to another batch", async () => {
    const first = await service.create(fixtures.hub.id, "PET");
    const second = await service.create(fixtures.hub.id, "PET");
    const event = await insertEvent(dataSource, fixtures, { capturedAt: at(0) });

    await service.addEvents(first.id, [event.id]);
    await expect(service.addEvents(second.id, [event.id])).rejects.toThrow(BadRequestException);
  });

  it("refuses an event captured at a different hub", async () => {
    const batch = await service.create(fixtures.hub.id, "PET");
    const elsewhere = await insertEvent(dataSource, fixtures, {
      capturedAt: at(0),
      hubId: fixtures.otherHub.id,
    });

    await expect(service.addEvents(batch.id, [elsewhere.id])).rejects.toThrow(BadRequestException);
  });

  it("refuses an event whose material does not match the batch", async () => {
    const batch = await service.create(fixtures.hub.id, "PET");
    const hdpe = await insertEvent(dataSource, fixtures, { capturedAt: at(0), material: "HDPE" });

    await expect(service.addEvents(batch.id, [hdpe.id])).rejects.toThrow(BadRequestException);
  });

  it("removes an event and recomputes the totals downward", async () => {
    const batch = await service.create(fixtures.hub.id, "PET");
    const kept = await insertEvent(dataSource, fixtures, { capturedAt: at(0), weightKg: 10 });
    const removed = await insertEvent(dataSource, fixtures, { capturedAt: at(1), weightKg: 4 });
    await service.addEvents(batch.id, [kept.id, removed.id]);

    const updated = await service.removeEvent(batch.id, removed.id);

    expect(updated.eventCount).toBe(1);
    expect(Number(updated.totalWeightKg)).toBe(10);
    // Freed, not destroyed: it can go into a later batch.
    const freed = await dataSource
      .getRepository(CollectionEventEntity)
      .findOneOrFail({ where: { id: removed.id } });
    expect(freed.batchId).toBeNull();
  });

  it("reports an event that is not in the batch rather than silently succeeding", async () => {
    const batch = await service.create(fixtures.hub.id, "PET");
    const stranger = await insertEvent(dataSource, fixtures, { capturedAt: at(0) });

    await expect(service.removeEvent(batch.id, stranger.id)).rejects.toThrow(NotFoundException);
  });
});

describe("BatchesService — sealing", () => {
  it("computes the root an independent verifier would compute", async () => {
    const batch = await service.create(fixtures.hub.id, "PET");
    const events = [
      await insertEvent(dataSource, fixtures, { capturedAt: at(0), weightKg: 10 }),
      await insertEvent(dataSource, fixtures, { capturedAt: at(5), weightKg: 5.5 }),
      await insertEvent(dataSource, fixtures, { capturedAt: at(10), weightKg: 2.25 }),
    ];
    await service.addEvents(
      batch.id,
      events.map((e) => e.id),
    );

    const sealed = await service.seal(batch.id);

    expect(sealed.merkleRoot).toBe(await independentlyRecomputedRoot(batch.id));
    expect(sealed.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
  });

  it("orders leaves by capture time, not by the order events were stored", async () => {
    // The ordering IS the root. If it ever depended on insertion order, two
    // honest runs over the same events would disagree and every proof already
    // issued would stop verifying.
    const batch = await service.create(fixtures.hub.id, "PET");
    const late = await insertEvent(dataSource, fixtures, { capturedAt: at(30) });
    const early = await insertEvent(dataSource, fixtures, { capturedAt: at(0) });
    const middle = await insertEvent(dataSource, fixtures, { capturedAt: at(15) });
    await service.addEvents(batch.id, [late.id, early.id, middle.id]);

    const sealed = await service.seal(batch.id);

    const expected = merkleRootHex(
      [early, middle, late].map((e) => hashLeaf(e.payloadHash)),
    );
    expect(sealed.merkleRoot).toBe(expected);
  });

  it("breaks ties on id so identical capture times still order deterministically", async () => {
    const batch = await service.create(fixtures.hub.id, "PET");
    const sameInstant = at(7);
    const a = await insertEvent(dataSource, fixtures, { capturedAt: sameInstant });
    const b = await insertEvent(dataSource, fixtures, { capturedAt: sameInstant });
    await service.addEvents(batch.id, [a.id, b.id]);

    const sealed = await service.seal(batch.id);

    const byId = [a, b].sort((x, y) => x.id.localeCompare(y.id));
    expect(sealed.merkleRoot).toBe(merkleRootHex(byId.map((e) => hashLeaf(e.payloadHash))));
  });

  it("records the sealed totals and timestamp", async () => {
    const batch = await service.create(fixtures.hub.id, "PET");
    const first = await insertEvent(dataSource, fixtures, { capturedAt: at(0), weightKg: 8.125 });
    const second = await insertEvent(dataSource, fixtures, { capturedAt: at(1), weightKg: 1.875 });
    await service.addEvents(batch.id, [first.id, second.id]);

    const sealed = await service.seal(batch.id);

    expect(sealed.status).toBe("sealed");
    expect(sealed.eventCount).toBe(2);
    expect(Number(sealed.totalWeightKg)).toBe(10);
    expect(sealed.sealedAt).toBeInstanceOf(Date);
  });

  it("refuses to seal an empty batch", async () => {
    const batch = await service.create(fixtures.hub.id, "PET");
    await expect(service.seal(batch.id)).rejects.toThrow(BadRequestException);
  });

  it("refuses to seal a batch holding a quarantined event", async () => {
    // addEvents already blocks this; the check in seal() is the second lock on
    // the same door, and it is the one that holds if a row is ever written by
    // another path (a migration, a fix-up script, a future importer).
    const batch = await service.create(fixtures.hub.id, "PET");
    await insertEvent(dataSource, fixtures, {
      capturedAt: at(0),
      quarantined: true,
      batchId: batch.id,
    });

    await expect(service.seal(batch.id)).rejects.toThrow(ConflictException);
  });

  it("cannot be sealed twice", async () => {
    const batch = await service.create(fixtures.hub.id, "PET");
    const event = await insertEvent(dataSource, fixtures, { capturedAt: at(0) });
    await service.addEvents(batch.id, [event.id]);
    await service.seal(batch.id);

    await expect(service.seal(batch.id)).rejects.toThrow(ConflictException);
  });

  it("keeps the first root when two seals race", async () => {
    const batch = await service.create(fixtures.hub.id, "PET");
    const event = await insertEvent(dataSource, fixtures, { capturedAt: at(0) });
    await service.addEvents(batch.id, [event.id]);

    // The row lock, not the status read, is what makes this safe: both
    // transactions pass the status check before either commits.
    const results = await Promise.allSettled([service.seal(batch.id), service.seal(batch.id)]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const reloaded = await service.findOne(batch.id);
    expect(reloaded.merkleRoot).toBe(await independentlyRecomputedRoot(batch.id));
  });

  it("freezes membership: no events can be added after sealing", async () => {
    const batch = await service.create(fixtures.hub.id, "PET");
    const inside = await insertEvent(dataSource, fixtures, { capturedAt: at(0) });
    await service.addEvents(batch.id, [inside.id]);
    await service.seal(batch.id);

    const latecomer = await insertEvent(dataSource, fixtures, { capturedAt: at(20) });
    await expect(service.addEvents(batch.id, [latecomer.id])).rejects.toThrow(ConflictException);
  });

  it("freezes membership: no events can be removed after sealing", async () => {
    const batch = await service.create(fixtures.hub.id, "PET");
    const event = await insertEvent(dataSource, fixtures, { capturedAt: at(0) });
    await service.addEvents(batch.id, [event.id]);
    await service.seal(batch.id);

    await expect(service.removeEvent(batch.id, event.id)).rejects.toThrow(ConflictException);
  });
});

describe("BatchesService — status transitions", () => {
  async function sealedBatch(): Promise<BatchEntity> {
    const batch = await service.create(fixtures.hub.id, "PET");
    const event = await insertEvent(dataSource, fixtures, { capturedAt: at(0) });
    await service.addEvents(batch.id, [event.id]);
    return service.seal(batch.id);
  }

  it("walks sealed -> processed -> sold", async () => {
    const batch = await sealedBatch();

    expect((await service.advanceStatus(batch.id, "processed")).status).toBe("processed");
    expect((await service.advanceStatus(batch.id, "sold")).status).toBe("sold");
  });

  it("refuses to set the status to sealed directly", async () => {
    // Sealing means computing and freezing a root. Letting the status endpoint
    // set it would mark a batch sealed with merkleRoot NULL: too late to add or
    // remove events, no root to anchor, and seal() itself only accepts an open
    // batch — the batch and every event in it would be stuck for good.
    const batch = await service.create(fixtures.hub.id, "PET");
    const event = await insertEvent(dataSource, fixtures, { capturedAt: at(0) });
    await service.addEvents(batch.id, [event.id]);

    await expect(service.advanceStatus(batch.id, "sealed")).rejects.toThrow(ConflictException);

    const reloaded = await service.findOne(batch.id);
    expect(reloaded.status).toBe("open");
    expect(reloaded.merkleRoot).toBeNull();
  });

  it("refuses to skip sealing on the way to processed", async () => {
    const batch = await service.create(fixtures.hub.id, "PET");
    await expect(service.advanceStatus(batch.id, "processed")).rejects.toThrow(ConflictException);
  });

  it("refuses to skip processing on the way to sold", async () => {
    const batch = await sealedBatch();
    await expect(service.advanceStatus(batch.id, "sold")).rejects.toThrow(ConflictException);
  });

  it("refuses to move a sold batch anywhere", async () => {
    const batch = await sealedBatch();
    await service.advanceStatus(batch.id, "processed");
    await service.advanceStatus(batch.id, "sold");

    await expect(service.advanceStatus(batch.id, "processed")).rejects.toThrow(ConflictException);
  });
});

describe("BatchesService — recording the anchor", () => {
  const TX_HASH = "a".repeat(64);

  async function sealedBatch(): Promise<BatchEntity> {
    const batch = await service.create(fixtures.hub.id, "PET");
    const event = await insertEvent(dataSource, fixtures, { capturedAt: at(0) });
    await service.addEvents(batch.id, [event.id]);
    return service.seal(batch.id);
  }

  function anchorInput(overrides: Partial<Parameters<BatchesService["recordAnchor"]>[1]> = {}) {
    return {
      merkleRoot: "b".repeat(64),
      stellarTxHash: TX_HASH,
      stellarLedger: 1_234_567,
      network: "testnet" as const,
      dataEntryKey: "proofchain:batch",
      anchoredAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it("records the transaction against a sealed batch", async () => {
    const batch = await sealedBatch();

    const anchor = await service.recordAnchor(
      batch.id,
      anchorInput({ merkleRoot: batch.merkleRoot! }),
    );

    expect(anchor.stellarTxHash).toBe(TX_HASH);
    expect(anchor.merkleRoot).toBe(batch.merkleRoot);
    expect(Number(anchor.stellarLedger)).toBe(1_234_567);
  });

  it("refuses a root that disagrees with the sealed batch", async () => {
    // An anchor pointing at the wrong data is worse than no anchor: it is a
    // public, permanent claim about a batch it does not describe.
    const batch = await sealedBatch();

    await expect(
      service.recordAnchor(batch.id, anchorInput({ merkleRoot: "c".repeat(64) })),
    ).rejects.toThrow(ConflictException);
  });

  it("refuses to anchor a batch that was never sealed", async () => {
    const batch = await service.create(fixtures.hub.id, "PET");

    await expect(service.recordAnchor(batch.id, anchorInput())).rejects.toThrow(ConflictException);
  });

  it("is idempotent when the worker retries the same transaction", async () => {
    const batch = await sealedBatch();
    const input = anchorInput({ merkleRoot: batch.merkleRoot! });

    const first = await service.recordAnchor(batch.id, input);
    const second = await service.recordAnchor(batch.id, input);

    expect(second.id).toBe(first.id);
    expect(await dataSource.getRepository(AnchorRecordEntity).count()).toBe(1);
  });

  it("refuses a second, different transaction for the same batch", async () => {
    const batch = await sealedBatch();
    await service.recordAnchor(batch.id, anchorInput({ merkleRoot: batch.merkleRoot! }));

    await expect(
      service.recordAnchor(
        batch.id,
        anchorInput({ merkleRoot: batch.merkleRoot!, stellarTxHash: "d".repeat(64) }),
      ),
    ).rejects.toThrow(ConflictException);
  });

  it("lists sealed unanchored batches as the worker's queue, oldest first", async () => {
    const first = await sealedBatch();
    const second = await sealedBatch();

    const pending = await service.pendingAnchor();
    expect(pending.map((p) => p.id)).toEqual([first.id, second.id]);

    await service.recordAnchor(first.id, anchorInput({ merkleRoot: first.merkleRoot! }));

    const afterAnchoring = await service.pendingAnchor();
    expect(afterAnchoring.map((p) => p.id)).toEqual([second.id]);
  });

  it("does not queue an open batch for anchoring", async () => {
    await service.create(fixtures.hub.id, "PET");
    expect(await service.pendingAnchor()).toEqual([]);
  });
});

describe("BatchesService — verifying one event", () => {
  it("produces a proof that validates against the sealed root", async () => {
    const batch = await service.create(fixtures.hub.id, "PET");
    const events = await Promise.all([
      insertEvent(dataSource, fixtures, { capturedAt: at(0) }),
      insertEvent(dataSource, fixtures, { capturedAt: at(5) }),
      insertEvent(dataSource, fixtures, { capturedAt: at(10) }),
      insertEvent(dataSource, fixtures, { capturedAt: at(15) }),
      insertEvent(dataSource, fixtures, { capturedAt: at(20) }),
    ]);
    await service.addEvents(
      batch.id,
      events.map((e) => e.id),
    );
    const sealed = await service.seal(batch.id);

    // Every member must verify, not just a convenient one — an odd leaf count
    // is where a Merkle implementation usually goes wrong.
    for (const event of events) {
      const verification = await service.verifyEvent(batch.id, event.id);

      expect(verification.proofValid).toBe(true);
      expect(verification.merkleRoot).toBe(sealed.merkleRoot);
      expect(verifyMerkleProof(verification.leaf, verification.proof, sealed.merkleRoot!)).toBe(
        true,
      );
      expect(verification.leaf).toBe(hashLeaf(event.payloadHash));
    }
  });

  it("reports no on-chain record until the batch is anchored, then reports it", async () => {
    const batch = await service.create(fixtures.hub.id, "PET");
    const event = await insertEvent(dataSource, fixtures, { capturedAt: at(0) });
    await service.addEvents(batch.id, [event.id]);
    const sealed = await service.seal(batch.id);

    expect((await service.verifyEvent(batch.id, event.id)).onChain).toBeNull();

    await service.recordAnchor(batch.id, {
      merkleRoot: sealed.merkleRoot!,
      stellarTxHash: "e".repeat(64),
      stellarLedger: 42,
      network: "testnet",
      dataEntryKey: "proofchain:batch",
      anchoredAt: new Date().toISOString(),
    });

    const verified = await service.verifyEvent(batch.id, event.id);
    expect(verified.onChain).toMatchObject({
      network: "testnet",
      txHash: "e".repeat(64),
      ledger: 42,
    });
    expect(verified.onChain?.explorerUrl).toContain("stellar.expert");
  });

  it("refuses to verify against a batch that has not been sealed", async () => {
    const batch = await service.create(fixtures.hub.id, "PET");
    const event = await insertEvent(dataSource, fixtures, { capturedAt: at(0) });
    await service.addEvents(batch.id, [event.id]);

    await expect(service.verifyEvent(batch.id, event.id)).rejects.toThrow(ConflictException);
  });

  it("reports an event that is not a member of the batch", async () => {
    const batch = await service.create(fixtures.hub.id, "PET");
    const member = await insertEvent(dataSource, fixtures, { capturedAt: at(0) });
    const stranger = await insertEvent(dataSource, fixtures, { capturedAt: at(1) });
    await service.addEvents(batch.id, [member.id]);
    await service.seal(batch.id);

    await expect(service.verifyEvent(batch.id, stranger.id)).rejects.toThrow(NotFoundException);
  });

  it("reports an unknown batch as missing rather than failing obscurely", async () => {
    await expect(
      service.verifyEvent("00000000-0000-4000-8000-000000000000", "irrelevant"),
    ).rejects.toThrow(NotFoundException);
  });
});
