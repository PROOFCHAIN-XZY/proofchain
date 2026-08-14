import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { WeighInPayload } from "@proofchain/shared";
import type { EventsService } from "../src/events/events.service";
import { CollectionEventEntity } from "../src/database/entities";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { seedHub, type SeededHub } from "./support/fixtures";
import { buildEventsService } from "./support/services";

/**
 * Ingest is where untrusted field input meets the database. Two properties
 * carry the weight: a failing weigh-in is stored rather than dropped (it is the
 * evidence that fraud detection works), and it can never enter a batch.
 */

let db: TestDatabase;
let service: EventsService;
let seeded: SeededHub;

beforeEach(async () => {
  db ??= await createTestDatabase();
  await db.reset();
  service = buildEventsService(db.dataSource);
  seeded = await seedHub(db.dataSource);
});

afterAll(async () => {
  await db?.close();
});

async function ingest(overrides: Partial<WeighInPayload> = {}) {
  const payload = seeded.payload(overrides);
  return service.ingest(payload, seeded.sign(payload));
}

describe("EventsService.ingest", () => {
  it("accepts a correctly signed weigh-in from an enrolled device", async () => {
    const result = await ingest();

    expect(result.quarantined).toBe(false);
    expect(result.duplicate).toBe(false);
    expect(result.integrity.outcome).toBe("pass");
    expect(result.payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("persists the signature and payload hash alongside the verdict", async () => {
    const result = await ingest({ weightKg: 9.25 });

    const stored = await db.dataSource
      .getRepository(CollectionEventEntity)
      .findOneByOrFail({ id: result.eventId });

    // The signature has to survive ingest verbatim: without it the record is
    // unverifiable by anyone who did not watch us receive it.
    expect(stored.signature).toBeTruthy();
    expect(stored.payloadHash).toBe(result.payloadHash);
    expect(Number(stored.weightKg)).toBe(9.25);
    expect(stored.batchId).toBeNull();
    expect(stored.integrity.outcome).toBe("pass");
  });

  it("rejects an unknown payload schema outright", async () => {
    const payload = seeded.payload({ schema: "proofchain.weighin.v2" as never });

    // Unlike an integrity failure, an unreadable schema cannot be judged at
    // all — storing it would put a record in the table nothing can interpret.
    await expect(service.ingest(payload, seeded.sign(payload))).rejects.toThrow(
      /unsupported payload schema/,
    );
  });
});

describe("EventsService.ingest — quarantine", () => {
  it("stores a weigh-in outside the geofence rather than dropping it", async () => {
    // ~3 km north of the hub, well outside the 300 m fence.
    const result = await ingest({ lat: seeded.hub.lat + 0.027 });

    expect(result.quarantined).toBe(true);
    expect(result.integrity.outcome).toBe("fail");
    expect(result.integrity.findings.some((f) => f.check === "geofence_ok")).toBe(true);

    // Kept, not discarded: quarantined records are the raw material of fraud
    // detection and of the "% captured cleanly" pilot metric.
    const stored = await db.dataSource
      .getRepository(CollectionEventEntity)
      .findOneByOrFail({ id: result.eventId });
    expect(stored.quarantined).toBe(true);
  });

  it("quarantines a payload whose signature does not cover it", async () => {
    const honest = seeded.payload({ weightKg: 5 });
    const signature = seeded.sign(honest);

    // The tamper an inflated credit needs: same signature, heavier payload.
    const inflated = { ...honest, weightKg: 500 };
    const result = await service.ingest(inflated, signature);

    expect(result.quarantined).toBe(true);
    expect(
      result.integrity.findings.find((f) => f.check === "signature_valid")?.outcome,
    ).toBe("fail");
  });

  it("quarantines a weigh-in above the hub's maximum weight", async () => {
    const result = await ingest({ weightKg: 900 });

    expect(result.quarantined).toBe(true);
    expect(result.integrity.findings.find((f) => f.check === "weight_in_range")?.outcome).toBe(
      "fail",
    );
  });

  it("quarantines a weigh-in from a revoked device", async () => {
    await db.dataSource
      .getRepository(CollectionEventEntity)
      .manager.update("devices", { id: seeded.device.id }, { revokedAt: new Date() });

    const result = await ingest();

    expect(result.quarantined).toBe(true);
    expect(result.integrity.findings.find((f) => f.check === "device_enrolled")?.outcome).toBe(
      "fail",
    );
  });
});
