import { afterAll, beforeEach, describe, expect, it } from "vitest";
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
