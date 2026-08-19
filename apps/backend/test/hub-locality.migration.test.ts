import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newDb } from "pg-mem";
import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";
import { HubLocality1786500000000 } from "../src/database/migrations/1786500000000-HubLocality";
import { ALL_ENTITIES, HubEntity } from "../src/database/entities";

/**
 * Runs the migration's SQL and then uses the entity against it, for the same
 * reason as the anchor-attempts suite: the rest of the tests build their schema
 * from the entities, so they would pass against a migration that adds nothing.
 * Production only ever runs the migration.
 */

let dataSource: DataSource;

beforeAll(async () => {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  db.public.registerFunction({
    name: "current_database",
    returns: "text" as never,
    implementation: () => "proofchain_test",
  });
  db.public.registerFunction({
    name: "version",
    returns: "text" as never,
    implementation: () => "PostgreSQL 16.0 (pg-mem)",
  });
  db.registerExtension("uuid-ossp", (schema) => {
    schema.registerFunction({
      name: "uuid_generate_v4",
      returns: "uuid" as never,
      implementation: () => randomUUID(),
      impure: true,
    });
  });

  dataSource = await db.adapters.createTypeormDataSource({
    type: "postgres",
    entities: ALL_ENTITIES,
  });
  await dataSource.initialize();
  await dataSource.synchronize();

  // Drop the columns synchronize() created so the migration is what puts them
  // back — otherwise this suite proves nothing about the migration.
  await dataSource.query(`ALTER TABLE "hubs" DROP COLUMN "locality"`);
  await dataSource.query(`ALTER TABLE "hubs" DROP COLUMN "localityResolvedAt"`);
  await dataSource.query(`ALTER TABLE "hubs" DROP COLUMN "localityAttribution"`);

  const runner = dataSource.createQueryRunner();
  await new HubLocality1786500000000().up(runner);
  await runner.release();
});

afterAll(async () => {
  await dataSource?.destroy();
});

describe("HubLocality migration", () => {
  it("adds columns the entity can be written through", async () => {
    const resolvedAt = new Date("2026-08-17T09:30:00.000Z");

    const saved = await dataSource.getRepository(HubEntity).save({
      code: "HUB-LOC",
      name: "Locality Hub",
      lat: -1.286389,
      lng: 36.817223,
      geofenceRadiusM: 250,
      minWeightKg: 0.1,
      maxWeightKg: 500,
      locality: "Nairobi, Nairobi County, Kenya",
      localityResolvedAt: resolvedAt,
      localityAttribution: "Data © OpenStreetMap contributors, ODbL 1.0.",
    } as HubEntity);

    const reloaded = await dataSource.getRepository(HubEntity).findOneByOrFail({ id: saved.id });

    expect(reloaded.locality).toBe("Nairobi, Nairobi County, Kenya");
    expect(reloaded.localityResolvedAt).toBeInstanceOf(Date);
    expect(reloaded.localityAttribution).toContain("OpenStreetMap");
  });

  it("leaves a hub enrolled without a label perfectly valid", async () => {
    // The state every pre-existing hub is in immediately after deploy. If this
    // were not writable, the migration would have broken hub enrolment for
    // anyone who has not run the backfill.
    const saved = await dataSource.getRepository(HubEntity).save({
      code: "HUB-NOLOC",
      name: "Unlabelled Hub",
      lat: 0,
      lng: 0,
      geofenceRadiusM: 250,
      minWeightKg: 0.1,
      maxWeightKg: 500,
    } as HubEntity);

    const reloaded = await dataSource.getRepository(HubEntity).findOneByOrFail({ id: saved.id });

    expect(reloaded.locality).toBeNull();
    expect(reloaded.localityResolvedAt).toBeNull();
    expect(reloaded.localityAttribution).toBeNull();
  });
});
