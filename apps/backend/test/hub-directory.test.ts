import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { RegistryService } from "../src/collectors/registry.service";
import { HubEntity } from "../src/database/entities";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { buildRegistryService } from "./support/services";

/**
 * The hub directory is the only configuration an unauthenticated field phone
 * ever reads, and what it contains decides whether a collector finds out about
 * a hub's weight ceiling while the material is still on the scale or hours
 * later, as a rejected row.
 */

let db: TestDatabase;
let service: RegistryService;

beforeEach(async () => {
  db ??= await createTestDatabase();
  await db.reset();
  service = buildRegistryService(db.dataSource);
});

afterAll(async () => {
  await db?.close();
});

async function seed(overrides: Partial<HubEntity> = {}): Promise<HubEntity> {
  return db.dataSource.getRepository(HubEntity).save({
    code: "NBO-01",
    name: "Nairobi Pilot Hub",
    minWeightKg: 0.5,
    maxWeightKg: 10_000,
    ...overrides,
  } as HubEntity);
}

describe("RegistryService.hubDirectory", () => {
  it("publishes the weight bounds a device needs to pre-check a weigh-in", async () => {
    await seed();

    const [entry] = await service.hubDirectory();

    expect(entry).toMatchObject({
      code: "NBO-01",
      minWeightKg: 0.5,
      maxWeightKg: 10_000,
    });
  });

  it("gives them as numbers, not the strings a numeric column serialises to", async () => {
    // The device compares these against a scale reading and formats them into
    // the copy a collector reads; a string would survive typechecking and fail
    // only in the field.
    await seed();

    const [entry] = await service.hubDirectory();

    expect(typeof entry?.minWeightKg).toBe("number");
    expect(typeof entry?.maxWeightKg).toBe("number");
  });

  it("still withholds everything a capture device has no business reading", async () => {
    await seed();

    const [entry] = await service.hubDirectory();

    expect(Object.keys(entry ?? {}).sort()).toEqual([
      "code",
      "id",
      "maxWeightKg",
      "minWeightKg",
      "name",
    ]);
  });
});
