import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { stubRequiredEnv } from "./support/services";
import { RegistryService } from "../src/collectors/registry.service";
import type { GeocodeResult, NominatimClient } from "../src/collectors/nominatim.client";
import { CollectorEntity, DeviceEntity, HubEntity } from "../src/database/entities";

/**
 * Hub enrolment must not depend on a geocoder.
 *
 * The label is decoration on an audit report; the hub is the thing field work
 * cannot proceed without. These tests pin that ordering, because the failure
 * they prevent — OSM rate-limiting an operator out of creating a hub — would
 * only ever show up during real onboarding.
 */

let db: TestDatabase;

/** A geocoder with a scripted answer, so no test touches the network. */
function stubGeocoder(answer: GeocodeResult): NominatimClient {
  return {
    enabled: true,
    reverseGeocode: async () => answer,
  } as unknown as NominatimClient;
}

function buildRegistry(geocoder: NominatimClient): RegistryService {
  stubRequiredEnv();
  return new RegistryService(
    db.dataSource.getRepository(CollectorEntity),
    db.dataSource.getRepository(DeviceEntity),
    db.dataSource.getRepository(HubEntity),
    geocoder,
  );
}

const HUB = {
  code: "KAD-01",
  name: "Kaduna Pilot Hub",
  lat: 10.5222,
  lng: 7.4383,
};

beforeAll(async () => {
  db = await createTestDatabase();
});

beforeEach(async () => {
  await db.reset();
});

afterAll(async () => {
  await db.close();
});

describe("createHub locality", () => {
  it("stores the label, its attribution and when it was resolved", async () => {
    const registry = buildRegistry(
      stubGeocoder({
        ok: true,
        value: { label: "Kaduna, Nigeria", attribution: "Data © OpenStreetMap contributors" },
      }),
    );

    const hub = await registry.createHub(HUB);

    expect(hub.locality).toBe("Kaduna, Nigeria");
    expect(hub.localityAttribution).toContain("OpenStreetMap");
    expect(hub.localityResolvedAt).toBeInstanceOf(Date);
  });

  it("creates the hub anyway when the geocoder is unavailable", async () => {
    const registry = buildRegistry(
      stubGeocoder({ ok: false, reason: "unavailable", detail: "returned 429" }),
    );

    const hub = await registry.createHub(HUB);

    // The hub exists and is fully usable — this is the whole point.
    expect(hub.id).toBeTruthy();
    expect(hub.lat).toBe(HUB.lat);
    expect(hub.geofenceRadiusM).toBe(250);
    expect(hub.locality).toBeNull();
    expect(hub.localityResolvedAt).toBeNull();
  });

  it("creates the hub anyway when reverse geocoding is disabled", async () => {
    const registry = buildRegistry(
      stubGeocoder({ ok: false, reason: "disabled", detail: "NOMINATIM_USER_AGENT is not set" }),
    );

    const hub = await registry.createHub(HUB);

    expect(hub.id).toBeTruthy();
    expect(hub.locality).toBeNull();
  });

  it("creates the hub anyway when the geocoder throws outright", async () => {
    // The client is written not to throw, but it is an I/O boundary and a future
    // change could regress that. A hub must not be lost to it either way.
    const throwing = {
      enabled: true,
      reverseGeocode: async () => {
        throw new Error("unexpected");
      },
    } as unknown as NominatimClient;

    const hub = await buildRegistry(throwing).createHub(HUB);

    expect(hub.id).toBeTruthy();
    expect(hub.locality).toBeNull();
  });
});
