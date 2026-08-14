import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { hashLeaf, merkleRootHex } from "@proofchain/shared";
import { BatchesService } from "../src/batches/batches.service";
import {
  AnchorRecordEntity,
  BatchEntity,
  CollectionEventEntity,
} from "../src/database/entities";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { insertEvent, seedHub, type SeededHub } from "./support/fixtures";

/**
 * The batch lifecycle is the hinge of the product: before seal a batch is a
 * mutable working set, after it the membership and root are frozen and a root
 * goes to a public ledger. Every test here is about something that must not be
 * possible to undo.
 */

let db: TestDatabase;
let service: BatchesService;
let seeded: SeededHub;

function buildService(database: TestDatabase): BatchesService {
  const { dataSource } = database;
  return new BatchesService(
    dataSource.getRepository(BatchEntity),
    dataSource.getRepository(CollectionEventEntity),
    dataSource.getRepository(AnchorRecordEntity),
    dataSource,
  );
}

beforeEach(async () => {
  db ??= await createTestDatabase();
  await db.reset();
  service = buildService(db);
  seeded = await seedHub(db.dataSource);
});

afterAll(async () => {
  await db?.close();
});

describe("BatchesService.create", () => {
  it("opens a batch with zeroed totals and no root", async () => {
    const batch = await service.create(seeded.hub.id, "pet");

    expect(batch.status).toBe("open");
    expect(batch.eventCount).toBe(0);
    expect(Number(batch.totalWeightKg)).toBe(0);
    // A root before sealing would mean a batch could be anchored while its
    // membership is still mutable.
    expect(batch.merkleRoot).toBeNull();
    expect(batch.sealedAt).toBeNull();
  });
});

describe("BatchesService.findOne", () => {
  it("returns the batch by id", async () => {
    const created = await service.create(seeded.hub.id, "pet");
    expect((await service.findOne(created.id)).id).toBe(created.id);
  });

  it("404s rather than returning null for an unknown id", async () => {
    await expect(service.findOne("00000000-0000-0000-0000-000000000000")).rejects.toThrow(
      /not found/,
    );
  });
});

describe("BatchesService.list", () => {
  it("filters by status", async () => {
    await service.create(seeded.hub.id, "pet");
    await service.create(seeded.hub.id, "hdpe");

    expect(await service.list("open")).toHaveLength(2);
    expect(await service.list("sealed")).toHaveLength(0);
  });

  it("returns every batch when no status is given", async () => {
    await service.create(seeded.hub.id, "pet");
    await service.create(seeded.hub.id, "hdpe");

    expect(await service.list()).toHaveLength(2);
  });
});

describe("BatchesService.addEvents", () => {
  it("attaches eligible events and recomputes the totals", async () => {
    const batch = await service.create(seeded.hub.id, "pet");
    const a = await insertEvent(db.dataSource, seeded, { weightKg: 10.25 });
    const b = await insertEvent(db.dataSource, seeded, { weightKg: 4.5 });

    const updated = await service.addEvents(batch.id, [a.id, b.id]);

    expect(updated.eventCount).toBe(2);
    expect(Number(updated.totalWeightKg)).toBe(14.75);
    // Membership lives on the event row, not on a join table — the batch is
    // whatever currently points at it.
    const rows = await service.eventsOf(batch.id);
    expect(rows.map((r) => r.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("refuses an event that is already in another batch", async () => {
    const first = await service.create(seeded.hub.id, "pet");
    const second = await service.create(seeded.hub.id, "pet");
    const event = await insertEvent(db.dataSource, seeded);

    await service.addEvents(first.id, [event.id]);

    await expect(service.addEvents(second.id, [event.id])).rejects.toThrow(/not eligible/);
    expect((await service.findOne(second.id)).eventCount).toBe(0);
  });

  it("rejects the whole call when any event is ineligible", async () => {
    const batch = await service.create(seeded.hub.id, "pet");
    const good = await insertEvent(db.dataSource, seeded);

    await expect(
      service.addEvents(batch.id, [good.id, "00000000-0000-0000-0000-000000000000"]),
    ).rejects.toThrow(/not eligible/);

    // All-or-nothing: a partially applied add would leave the operator
    // believing a batch holds events it does not.
    expect((await service.findOne(batch.id)).eventCount).toBe(0);
  });
});

describe("BatchesService.addEvents — quarantine", () => {
  it("refuses a quarantined event", async () => {
    const batch = await service.create(seeded.hub.id, "pet");
    const bad = await insertEvent(db.dataSource, seeded, {
      quarantined: true,
      integrity: {
        outcome: "fail",
        findings: [{ check: "geofence", outcome: "fail", detail: "1.2 km from hub" }],
      },
    });

    // The whole economic argument rests on this: a weigh-in that failed an
    // integrity check must not be able to reach a saleable credit.
    await expect(service.addEvents(batch.id, [bad.id])).rejects.toThrow(/not eligible/);
    expect((await service.findOne(batch.id)).eventCount).toBe(0);
  });

  it("keeps clean events out of a batch when a quarantined one is in the same call", async () => {
    const batch = await service.create(seeded.hub.id, "pet");
    const good = await insertEvent(db.dataSource, seeded);
    const bad = await insertEvent(db.dataSource, seeded, { quarantined: true });

    await expect(service.addEvents(batch.id, [good.id, bad.id])).rejects.toThrow(/not eligible/);

    const reloaded = await db.dataSource
      .getRepository(CollectionEventEntity)
      .findOneByOrFail({ id: good.id });
    expect(reloaded.batchId).toBeNull();
  });
});

describe("BatchesService.addEvents — hub and material boundaries", () => {
  it("refuses an event captured at a different hub", async () => {
    const other = await seedHub(db.dataSource);
    const batch = await service.create(seeded.hub.id, "pet");
    const foreign = await insertEvent(db.dataSource, other);

    // Hub membership is what ties a batch to a geofence and an operator; a
    // cross-hub event would make the batch's provenance unstateable.
    await expect(service.addEvents(batch.id, [foreign.id])).rejects.toThrow(/not eligible/);
  });

  it("refuses an event whose material differs from the batch", async () => {
    const batch = await service.create(seeded.hub.id, "pet");
    const hdpe = await insertEvent(db.dataSource, seeded, { material: "hdpe" });

    // Distinguished from the eligibility rejection: the event is otherwise
    // addable, so the operator needs to be told which rule it broke.
    await expect(service.addEvents(batch.id, [hdpe.id])).rejects.toThrow(
      /do not match batch material pet/,
    );
    expect((await service.findOne(batch.id)).eventCount).toBe(0);
  });
});

describe("BatchesService.addEvents — sealed membership", () => {
  it("refuses to add events once the batch is sealed", async () => {
    const batch = await service.create(seeded.hub.id, "pet");
    const first = await insertEvent(db.dataSource, seeded);
    await service.addEvents(batch.id, [first.id]);
    await service.seal(batch.id);

    const late = await insertEvent(db.dataSource, seeded);

    // Adding after seal would change the set the root commits to, silently
    // invalidating every proof already handed to a buyer.
    await expect(service.addEvents(batch.id, [late.id])).rejects.toThrow(/is sealed, not open/);
  });

  it("404s when the batch does not exist", async () => {
    const event = await insertEvent(db.dataSource, seeded);
    await expect(
      service.addEvents("00000000-0000-0000-0000-000000000000", [event.id]),
    ).rejects.toThrow(/not found/);
  });
});

describe("BatchesService.removeEvent", () => {
  it("detaches an event and recomputes the totals", async () => {
    const batch = await service.create(seeded.hub.id, "pet");
    const keep = await insertEvent(db.dataSource, seeded, { weightKg: 8 });
    const drop = await insertEvent(db.dataSource, seeded, { weightKg: 3.5 });
    await service.addEvents(batch.id, [keep.id, drop.id]);

    const updated = await service.removeEvent(batch.id, drop.id);

    expect(updated.eventCount).toBe(1);
    expect(Number(updated.totalWeightKg)).toBe(8);
  });

  it("returns the removed event to the eligible pool", async () => {
    const batch = await service.create(seeded.hub.id, "pet");
    const event = await insertEvent(db.dataSource, seeded);
    await service.addEvents(batch.id, [event.id]);
    await service.removeEvent(batch.id, event.id);

    // Detaching must clear batchId, not merely delete the association row —
    // otherwise the event is stranded, countable nowhere.
    const other = await service.create(seeded.hub.id, "pet");
    await expect(service.addEvents(other.id, [event.id])).resolves.toMatchObject({
      eventCount: 1,
    });
  });

  it("refuses to detach from a sealed batch", async () => {
    const batch = await service.create(seeded.hub.id, "pet");
    const event = await insertEvent(db.dataSource, seeded);
    await service.addEvents(batch.id, [event.id]);
    await service.seal(batch.id);

    await expect(service.removeEvent(batch.id, event.id)).rejects.toThrow(
      /sealed membership cannot change/,
    );
  });

  it("404s for an event that is not in the batch", async () => {
    const batch = await service.create(seeded.hub.id, "pet");
    const loose = await insertEvent(db.dataSource, seeded);

    await expect(service.removeEvent(batch.id, loose.id)).rejects.toThrow(/is not in batch/);
  });
});

describe("BatchesService — weight totals", () => {
  it("keeps three-decimal totals exact under float accumulation", async () => {
    const batch = await service.create(seeded.hub.id, "pet");
    // 0.1 + 0.2 is the canonical float trap; naive summation yields
    // 0.30000000000000004 and the batch would advertise a weight no scale
    // ever measured.
    const a = await insertEvent(db.dataSource, seeded, { weightKg: 0.1 });
    const b = await insertEvent(db.dataSource, seeded, { weightKg: 0.2 });

    const updated = await service.addEvents(batch.id, [a.id, b.id]);
    expect(Number(updated.totalWeightKg)).toBe(0.3);
  });

  it("reads weights back as numbers, not numeric strings", async () => {
    const batch = await service.create(seeded.hub.id, "pet");
    const event = await insertEvent(db.dataSource, seeded, { weightKg: 12.345 });
    await service.addEvents(batch.id, [event.id]);

    const reloaded = await service.findOne(batch.id);
    // node-postgres hands back `numeric` as a string; a string here would
    // concatenate rather than add in every downstream total.
    expect(typeof reloaded.totalWeightKg).toBe("number");
    expect(reloaded.totalWeightKg).toBe(12.345);
  });
});

describe("BatchesService.seal", () => {
  it("freezes the root, the totals and the sealed timestamp", async () => {
    const batch = await service.create(seeded.hub.id, "pet");
    const events = [
      await insertEvent(db.dataSource, seeded, { weightKg: 5 }),
      await insertEvent(db.dataSource, seeded, { weightKg: 7.5 }),
      await insertEvent(db.dataSource, seeded, { weightKg: 2.25 }),
    ];
    await service.addEvents(
      batch.id,
      events.map((e) => e.id),
    );

    const sealed = await service.seal(batch.id);

    expect(sealed.status).toBe("sealed");
    expect(sealed.merkleRoot).toMatch(/^[0-9a-f]{64}$/);
    expect(sealed.sealedAt).toBeInstanceOf(Date);
    expect(sealed.eventCount).toBe(3);
    expect(Number(sealed.totalWeightKg)).toBe(14.75);
  });

  it("produces the root an auditor recomputes from the event list alone", async () => {
    const batch = await service.create(seeded.hub.id, "pet");
    const events = [
      await insertEvent(db.dataSource, seeded),
      await insertEvent(db.dataSource, seeded),
    ];
    await service.addEvents(
      batch.id,
      events.map((e) => e.id),
    );
    const sealed = await service.seal(batch.id);

    // This is the whole verification story in one assertion: the stored root
    // is reproducible from public data, using only the documented algorithm.
    const ordered = await service.eventsOf(batch.id);
    const expected = merkleRootHex(ordered.map((e) => hashLeaf(e.payloadHash)));
    expect(sealed.merkleRoot).toBe(expected);
  });
});

describe("BatchesService.seal — refusals", () => {
  it("refuses to seal an empty batch", async () => {
    const batch = await service.create(seeded.hub.id, "pet");
    // An empty batch has a defined root under most Merkle conventions, and
    // anchoring one would spend a real transaction attesting to nothing.
    await expect(service.seal(batch.id)).rejects.toThrow(/cannot seal an empty batch/);
  });

  it("refuses a second seal", async () => {
    const batch = await service.create(seeded.hub.id, "pet");
    const event = await insertEvent(db.dataSource, seeded);
    await service.addEvents(batch.id, [event.id]);
    const first = await service.seal(batch.id);

    await expect(service.seal(batch.id)).rejects.toThrow(/already sealed/);

    // The first root stands. A re-seal that recomputed would be able to move
    // the root out from under proofs already issued.
    expect((await service.findOne(batch.id)).merkleRoot).toBe(first.merkleRoot);
  });

  it("refuses to seal a batch holding a quarantined event", async () => {
    const batch = await service.create(seeded.hub.id, "pet");
    const event = await insertEvent(db.dataSource, seeded);
    await service.addEvents(batch.id, [event.id]);

    // Quarantine after the add: addEvents screens on the way in, but the
    // integrity verdict can change afterwards, so seal re-checks.
    await db.dataSource
      .getRepository(CollectionEventEntity)
      .update({ id: event.id }, { quarantined: true });

    await expect(service.seal(batch.id)).rejects.toThrow(/contains quarantined events/);
    expect((await service.findOne(batch.id)).status).toBe("open");
  });
});

describe("BatchesService — leaf ordering", () => {
  it("orders leaves by capture time, not by insertion order", async () => {
    const batch = await service.create(seeded.hub.id, "pet");
    const later = await insertEvent(db.dataSource, seeded, {
      capturedAt: new Date("2026-03-01T10:00:00.000Z"),
    });
    const earlier = await insertEvent(db.dataSource, seeded, {
      capturedAt: new Date("2026-03-01T08:00:00.000Z"),
    });
    await service.addEvents(batch.id, [later.id, earlier.id]);

    const ordered = await service.eventsOf(batch.id);
    expect(ordered.map((e) => e.id)).toEqual([earlier.id, later.id]);
  });

  it("derives the same root regardless of the order events were added in", async () => {
    const capturedAt = [
      new Date("2026-03-01T08:00:00.000Z"),
      new Date("2026-03-01T09:00:00.000Z"),
      new Date("2026-03-01T10:00:00.000Z"),
    ];

    const rootFor = async (order: number[]): Promise<string> => {
      await db.reset();
      const local = buildService(db);
      const hub = await seedHub(db.dataSource);
      const batch = await local.create(hub.hub.id, "pet");
      const made = [];
      for (const [index, at] of capturedAt.entries()) {
        made.push(
          await insertEvent(db.dataSource, hub, {
            capturedAt: at,
            weightKg: 1,
            // Fixed payload hashes: the leaves must be identical across both
            // runs or the comparison would only be testing the fixture's RNG.
            payloadHash: `${index}`.repeat(64).slice(0, 64),
          }),
        );
      }
      await local.addEvents(
        batch.id,
        order.map((i) => made[i]!.id),
      );
      return (await local.seal(batch.id)).merkleRoot!;
    };

    // Ordering is part of the commitment: if it depended on the operator's
    // click order, two honest operators would anchor different roots for the
    // same three weigh-ins.
    expect(await rootFor([2, 0, 1])).toBe(await rootFor([0, 1, 2]));
  });
});
