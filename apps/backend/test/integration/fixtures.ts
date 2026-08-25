import { createHash, randomUUID } from "node:crypto";
import type { DataSource } from "typeorm";
import type { MaterialType } from "@proofchain/shared";
import {
  CollectionEventEntity,
  CollectorEntity,
  DeviceEntity,
  HubEntity,
} from "../../src/database/entities";

/**
 * Minimal, realistic rows for the batch tests.
 *
 * These insert events directly rather than going through EventsService.ingest,
 * on purpose: the batch services must hold their guarantees for whatever is in
 * the table, including rows a future ingest path might write differently. It
 * also lets a test place a quarantined event straight into a batch, which the
 * ingest path would never do — that is exactly the "defence in depth" case
 * seal() claims to catch.
 */

export interface Fixtures {
  hub: HubEntity;
  otherHub: HubEntity;
  collector: CollectorEntity;
  device: DeviceEntity;
}

export async function seedFixtures(dataSource: DataSource): Promise<Fixtures> {
  const hubs = dataSource.getRepository(HubEntity);
  const collectors = dataSource.getRepository(CollectorEntity);
  const devices = dataSource.getRepository(DeviceEntity);

  const hub = await hubs.save(
    hubs.create({
      code: "NRB-01",
      name: "Nairobi Pilot Hub",
      minWeightKg: 0.1,
      maxWeightKg: 500,
    }),
  );

  // A second hub, so "an event from another hub is not eligible" is testable
  // against a real row rather than a made-up id.
  const otherHub = await hubs.save(
    hubs.create({
      code: "MSA-01",
      name: "Mombasa Hub",
      minWeightKg: 0.1,
      maxWeightKg: 500,
    }),
  );

  const collector = await collectors.save(
    collectors.create({
      name: "Amina Wanjiru",
      phone: "+254700000001",
      cooperativeId: null,
      kycLevel: "basic",
      active: true,
    }),
  );

  const device = await devices.save(
    devices.create({
      collectorId: collector.id,
      label: "Test device",
      // Shape-correct base64 for a 32-byte key; nothing here verifies a
      // signature, so it only has to be unique and well-formed.
      publicKeyBase64: Buffer.from(randomUUID().replace(/-/g, ""), "hex").toString("base64"),
      revokedAt: null,
    }),
  );

  return { hub, otherHub, collector, device };
}

export interface EventOptions {
  capturedAt: Date;
  weightKg?: number;
  material?: MaterialType;
  quarantined?: boolean;
  hubId?: string;
  batchId?: string | null;
}

let payloadCounter = 0;

/**
 * One collection event. `payloadHash` is a real sha256 — it is what the Merkle
 * leaf is built from, so a placeholder that is not 64 hex chars would make the
 * proofs unrepresentative of production.
 */
export async function insertEvent(
  dataSource: DataSource,
  fixtures: Fixtures,
  options: EventOptions,
): Promise<CollectionEventEntity> {
  const events = dataSource.getRepository(CollectionEventEntity);
  const payloadHash = createHash("sha256")
    .update(`test-payload-${payloadCounter++}-${randomUUID()}`)
    .digest("hex");

  return events.save(
    events.create({
      collectorId: fixtures.collector.id,
      hubId: options.hubId ?? fixtures.hub.id,
      deviceId: fixtures.device.id,
      batchId: options.batchId ?? null,
      weightKg: options.weightKg ?? 12.5,
      material: options.material ?? "PET",
      capturedAt: options.capturedAt,
      receivedAt: options.capturedAt,
      photoHash: createHash("sha256").update(`photo-${payloadHash}`).digest("hex"),
      photoUri: null,
      nonce: randomUUID(),
      signature: Buffer.from(`signature-${payloadHash}`).toString("base64"),
      payloadHash,
      integrity: options.quarantined
        ? {
            outcome: "fail",
            findings: [{ check: "weight_in_range", outcome: "fail", detail: "weight out of range" }],
          }
        : { outcome: "pass", findings: [{ check: "weight_in_range", outcome: "pass" }] },
      quarantined: options.quarantined ?? false,
    }),
  );
}

/** Minutes after a fixed instant, so capture order is explicit in each test. */
export function at(minutes: number): Date {
  return new Date(Date.UTC(2026, 7, 14, 8, 0, 0) + minutes * 60_000);
}
