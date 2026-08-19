import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { stubRequiredEnv } from "./support/services";
import { RegistryService } from "../src/collectors/registry.service";
import type { NominatimClient } from "../src/collectors/nominatim.client";
import { CollectorEntity, DeviceEntity, HubEntity } from "../src/database/entities";

/**
 * The hub directory is the one registry read a capture device may make without
 * credentials, so what it exposes is a deliberate decision rather than an
 * accident of returning the entity.
 */

let db: TestDatabase;

function buildRegistry(): RegistryService {
  stubRequiredEnv();
  const geocoder = {
    enabled: false,
    reverseGeocode: async () => ({
      ok: false as const,
      reason: "disabled" as const,
      detail: "off in tests",
    }),
  } as unknown as NominatimClient;

  return new RegistryService(
    db.dataSource.getRepository(CollectorEntity),
    db.dataSource.getRepository(DeviceEntity),
    db.dataSource.getRepository(HubEntity),
    geocoder,
  );
}

beforeAll(async () => {
  db = await createTestDatabase();
});

beforeEach(async () => {
  await db.reset();
});

afterAll(async () => {
  await db.close();
});

describe("hubDirectory", () => {
  it("returns what a device needs to judge a fix", async () => {
    const registry = buildRegistry();
    await registry.createHub({
      code: "LAG-01",
      name: "Lagos Hub",
      lat: 6.524379,
      lng: 3.379206,
      geofenceRadiusM: 500,
    });

    const [hub] = await registry.hubDirectory();

    expect(hub).toEqual({
      id: expect.any(String),
      code: "LAG-01",
      name: "Lagos Hub",
      lat: 6.524379,
      lng: 3.379206,
      geofenceRadiusM: 500,
    });
  });

  it("withholds operational configuration from an unauthenticated caller", async () => {
    const registry = buildRegistry();
    await registry.createHub({
      code: "NBO-01",
      name: "Nairobi Pilot Hub",
      lat: -1.286389,
      lng: 36.817223,
      minWeightKg: 0.5,
      maxWeightKg: 200,
    });

    const [hub] = await registry.hubDirectory();

    // Coordinates and fences are already on every enrolled phone and printed in
    // audit reports. The weight bounds are not, and an attacker who knows them
    // knows exactly what weight passes the range check unremarked.
    expect(hub).not.toHaveProperty("minWeightKg");
    expect(hub).not.toHaveProperty("maxWeightKg");
    expect(hub).not.toHaveProperty("createdAt");
  });

  it("orders by code so the picker is stable between refreshes", async () => {
    const registry = buildRegistry();
    for (const code of ["POR-01", "ABU-01", "KAN-01"]) {
      await registry.createHub({ code, name: `${code} Hub`, lat: 9, lng: 7 });
    }

    expect((await registry.hubDirectory()).map((h) => h.code)).toEqual([
      "ABU-01",
      "KAN-01",
      "POR-01",
    ]);
  });

  it("is empty rather than failing when no hubs exist", async () => {
    expect(await buildRegistry().hubDirectory()).toEqual([]);
  });
});
