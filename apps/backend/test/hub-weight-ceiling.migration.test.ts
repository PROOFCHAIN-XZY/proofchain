import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { newDb } from "pg-mem";
import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";
import { HubWeightCeiling1786900000000 } from "../src/database/migrations/1786900000000-HubWeightCeiling";
import { ALL_ENTITIES, HubEntity } from "../src/database/entities";

/**
 * The migration exists to fix hubs that are already in a database, not just the
 * column default — a deployment's pilot hub was created at 200 kg and every
 * over-limit weigh-in it quarantined was real work that went unpaid. A migration
 * that only moved the default would have left it exactly as it was.
 */

let dataSource: DataSource;

beforeEach(async () => {
  await dataSource?.destroy();

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
});

afterAll(async () => {
  await dataSource?.destroy();
});

async function runMigration(): Promise<void> {
  const runner = dataSource.createQueryRunner();
  await new HubWeightCeiling1786900000000().up(runner);
  await runner.release();
}

async function seedHub(code: string, maxWeightKg: number): Promise<string> {
  const hub = await dataSource.getRepository(HubEntity).save({
    code,
    name: `${code} hub`,
    minWeightKg: 0.5,
    maxWeightKg,
  } as HubEntity);

  return hub.id;
}

async function ceilingOf(id: string): Promise<number> {
  const hub = await dataSource.getRepository(HubEntity).findOneByOrFail({ id });
  return hub.maxWeightKg;
}

describe("HubWeightCeiling migration", () => {
  it("raises a hub already capped below ten tonnes", async () => {
    const id = await seedHub("NBO-01", 200);

    await runMigration();

    expect(await ceilingOf(id)).toBe(10_000);
  });

  it("raises the old 500 kg default too", async () => {
    const id = await seedHub("LAG-01", 500);

    await runMigration();

    expect(await ceilingOf(id)).toBe(10_000);
  });

  it("leaves a hub an operator deliberately set higher alone", async () => {
    // Raising a floor under everybody, not imposing a number.
    const id = await seedHub("MSA-01", 25_000);

    await runMigration();

    expect(await ceilingOf(id)).toBe(25_000);
  });

  it("does not touch the minimum", async () => {
    const id = await seedHub("KSM-01", 200);

    await runMigration();

    const hub = await dataSource.getRepository(HubEntity).findOneByOrFail({ id });
    expect(hub.minWeightKg).toBe(0.5);
  });
});
