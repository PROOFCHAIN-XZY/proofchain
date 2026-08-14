import { createHash, randomUUID } from "node:crypto";
import type { DataSource } from "typeorm";
import {
  eventPayloadHash,
  generateDeviceKeypair,
  generateNonce,
  publicKeyToBase64,
  signWeighIn,
  type MaterialType,
  type WeighInPayload,
} from "@proofchain/shared";
import {
  CollectionEventEntity,
  CollectorEntity,
  DeviceEntity,
  HubEntity,
} from "../../src/database/entities";

/**
 * Fixture builders for the service suites.
 *
 * Every builder takes overrides so a test can state only the field under test.
 * That is the difference between a test that reads as "a weigh-in 400 metres
 * outside the geofence" and one that reads as forty lines of unrelated setup.
 */

export const NAIROBI = { lat: -1.2921, lng: 36.8219 } as const;

export interface SeededHub {
  hub: HubEntity;
  collector: CollectorEntity;
  device: DeviceEntity;
  /** Signs as the enrolled device, so signature checks pass for real. */
  sign(payload: WeighInPayload): string;
  /** A payload that passes every integrity check unless overridden. */
  payload(overrides?: Partial<WeighInPayload>): WeighInPayload;
}

export function photoHashOf(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

export async function seedHub(
  dataSource: DataSource,
  overrides: {
    hub?: Partial<HubEntity>;
    collector?: Partial<CollectorEntity>;
    device?: Partial<DeviceEntity>;
  } = {},
): Promise<SeededHub> {
  const hub = await dataSource.getRepository(HubEntity).save({
    code: `HUB-${randomUUID().slice(0, 8)}`,
    name: "Test Hub",
    lat: NAIROBI.lat,
    lng: NAIROBI.lng,
    geofenceRadiusM: 300,
    minWeightKg: 0.1,
    maxWeightKg: 500,
    ...overrides.hub,
  } as HubEntity);

  const collector = await dataSource.getRepository(CollectorEntity).save({
    name: "Amina Wanjiru",
    phone: `+2547${Math.floor(Math.random() * 1e8)
      .toString()
      .padStart(8, "0")}`,
    cooperativeId: null,
    kycLevel: "basic",
    homeLat: null,
    homeLng: null,
    active: true,
    ...overrides.collector,
  } as CollectorEntity);

  const keypair = generateDeviceKeypair();
  const device = await dataSource.getRepository(DeviceEntity).save({
    collectorId: collector.id,
    label: "field phone 1",
    publicKeyBase64: publicKeyToBase64(keypair.publicKey),
    revokedAt: null,
    ...overrides.device,
  } as DeviceEntity);

  return {
    hub,
    collector,
    device,
    sign: (payload) => signWeighIn(payload, keypair.privateKey),
    payload: (o = {}) => ({
      schema: "proofchain.weighin.v1",
      collectorId: collector.id,
      hubId: hub.id,
      deviceId: device.id,
      weightKg: 12.5,
      material: "pet",
      lat: hub.lat,
      lng: hub.lng,
      capturedAt: new Date().toISOString(),
      photoHash: photoHashOf(`photo-${randomUUID()}`),
      nonce: generateNonce(),
      ...o,
    }),
  };
}

/**
 * Insert an event directly, bypassing ingest.
 *
 * The batch suite is about membership and sealing, not about integrity, so it
 * should not have to route every fixture through signature verification —
 * but the row must still be *shaped* like a real one, because the Merkle leaf
 * derives from payloadHash.
 */
export async function insertEvent(
  dataSource: DataSource,
  seeded: SeededHub,
  overrides: Partial<CollectionEventEntity> & { capturedAt?: Date } = {},
): Promise<CollectionEventEntity> {
  const payload = seeded.payload({
    weightKg: overrides.weightKg !== undefined ? Number(overrides.weightKg) : 12.5,
    material: (overrides.material as MaterialType) ?? "pet",
    capturedAt: (overrides.capturedAt ?? new Date()).toISOString(),
  });
  const signature = seeded.sign(payload);

  return dataSource.getRepository(CollectionEventEntity).save({
    collectorId: seeded.collector.id,
    hubId: seeded.hub.id,
    deviceId: seeded.device.id,
    batchId: null,
    weightKg: payload.weightKg,
    material: payload.material,
    lat: payload.lat,
    lng: payload.lng,
    capturedAt: new Date(payload.capturedAt),
    receivedAt: new Date(),
    photoHash: payload.photoHash,
    photoUri: null,
    nonce: payload.nonce,
    signature,
    payloadHash: eventPayloadHash(payload),
    integrity: { outcome: "pass", findings: [] },
    quarantined: false,
    ...overrides,
  } as CollectionEventEntity);
}
