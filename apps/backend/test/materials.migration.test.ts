import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newDb } from "pg-mem";
import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";
import { normaliseExamples, SEED_MATERIALS } from "@proofchain/shared";
import { Materials1786600000000 } from "../src/database/migrations/1786600000000-Materials";
import { MaterialExamples1786700000000 } from "../src/database/migrations/1786700000000-MaterialExamples";
import { ALL_ENTITIES, MaterialEntity } from "../src/database/entities";

/**
 * Runs the migration's own SQL, then uses the entity against it.
 *
 * The rest of the suite builds its schema from the entities via synchronize(),
 * which would pass just as happily against a migration that was never written.
 * Production runs the migration and never synchronizes, so a column the entity
 * expects and the migration does not create only fails on deploy — against the
 * database holding the evidentiary record.
 *
 * This migration carries more than a table: it seeds the catalogue. An empty
 * `materials` table means ingest rejects every weigh-in, so the seed rows landing
 * is as much a part of the deploy as the DDL.
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

  /**
   * pg-mem does not implement Postgres's `~` regex-match operator, which the
   * migration's CHECK constraint on the code shape uses.
   *
   * Teaching it here rather than weakening the constraint: the constraint is the
   * last line of defence on an identifier that becomes permanent the moment a
   * device signs it, and a future script that bypasses the DTO must still be
   * unable to insert `pet plastic`. JavaScript's RegExp and Postgres's POSIX
   * regexes agree on the character classes and anchors this pattern uses.
   */
  db.public.registerOperator({
    operator: "~",
    left: "text" as never,
    right: "text" as never,
    returns: "bool" as never,
    implementation: (value: string, pattern: string) => new RegExp(pattern).test(value),
  });

  dataSource = await db.adapters.createTypeormDataSource({
    type: "postgres",
    entities: ALL_ENTITIES,
  });
  await dataSource.initialize();

  // Everything except `materials` comes from synchronize(); the table under test
  // must come from the migration, which is the whole point.
  await dataSource.synchronize();
  await dataSource.query(`DROP TABLE "materials" CASCADE`);

  const runner = dataSource.createQueryRunner();
  // In deploy order. The second migration adds a column to the table the first
  // creates and backfills the rows it seeded, so running them apart would test a
  // schema no database ever has.
  await new Materials1786600000000().up(runner);
  await new MaterialExamples1786700000000().up(runner);
  await runner.release();
});

afterAll(async () => {
  await dataSource?.destroy();
});

describe("Materials migration", () => {
  it("creates a table the entity can be written through", async () => {
    const saved = await dataSource.getRepository(MaterialEntity).save({
      code: "PVC",
      name: "Pipe and profile",
      description: "Rigid pipe, window profile.",
      examples: ["Pipe offcuts", "Window frames"],
      active: true,
      sortOrder: 70,
    } as MaterialEntity);

    const reloaded = await dataSource
      .getRepository(MaterialEntity)
      .findOneByOrFail({ code: saved.code });

    expect(reloaded.code).toBe("PVC");
    expect(reloaded.name).toBe("Pipe and profile");
    expect(reloaded.description).toContain("Rigid pipe");
    expect(reloaded.examples).toEqual(["Pipe offcuts", "Window frames"]);
    expect(reloaded.active).toBe(true);
    expect(reloaded.sortOrder).toBe(70);
    expect(reloaded.createdAt).toBeInstanceOf(Date);
    expect(reloaded.updatedAt).toBeInstanceOf(Date);
  });

  /**
   * A migrated database must never have an empty picker: ingest refuses a
   * material the catalogue does not know, so an unseeded deploy would reject
   * every weigh-in in the field.
   */
  it("seeds the codes the pilot already anchored", async () => {
    const rows = await dataSource.getRepository(MaterialEntity).find();
    const codes = rows.map((r) => r.code);

    for (const seed of SEED_MATERIALS) {
      expect(codes, seed.code).toContain(seed.code);
    }
  });

  it("seeds them active, with the names and descriptions from the shared package", async () => {
    for (const seed of SEED_MATERIALS) {
      const row = await dataSource
        .getRepository(MaterialEntity)
        .findOneByOrFail({ code: seed.code });

      expect(row.active, seed.code).toBe(true);
      expect(row.name, seed.code).toBe(seed.name);
      expect(row.description, seed.code).toBe(seed.description);
      expect(row.examples, seed.code).toEqual(seed.examples);
      expect(row.sortOrder, seed.code).toBe(seed.sortOrder);
    }
  });

  it("defaults a row to active with no explicit flag", async () => {
    await dataSource.query(
      `INSERT INTO "materials" ("code", "name") VALUES ('ABS', 'Casings and toys')`,
    );

    const row = await dataSource.getRepository(MaterialEntity).findOneByOrFail({ code: "ABS" });
    expect(row.active).toBe(true);
    expect(row.sortOrder).toBe(100);
  });

  /**
   * Defence in depth behind the DTO. A code becomes permanent the moment a device
   * signs it, so the database refuses a malformed one even if it arrives from a
   * script, a psql session, or a future endpoint that forgets to validate.
   */
  it.each([
    ["lowercase", "pvc"],
    ["a space", "MIXED PLASTIC"],
    ["a single character", "X"],
    ["a dot", "PET.1"],
  ])("refuses a code containing %s at the database level", async (_why, code) => {
    await expect(
      dataSource.query(`INSERT INTO "materials" ("code", "name") VALUES ($1, 'Bad')`, [code]),
    ).rejects.toThrow();
  });

  it("rejects a duplicate code, since code is the primary key", async () => {
    await expect(
      dataSource.query(`INSERT INTO "materials" ("code", "name") VALUES ('PET', 'Duplicate')`),
    ).rejects.toThrow();
  });

  /**
   * The backfill is for the seeded codes only. A material an operator added
   * before this migration keeps an empty list rather than inheriting products
   * from a code it has nothing to do with — theirs to fill in from the dashboard.
   */
  it("leaves a material it did not seed with an empty product list", async () => {
    await dataSource.query(
      `INSERT INTO "materials" ("code", "name") VALUES ('PVC-R', 'Rigid PVC')`,
    );

    const row = await dataSource.getRepository(MaterialEntity).findOneByOrFail({ code: "PVC-R" });
    // Asserted through the normaliser rather than on the raw column, because a
    // defaulted array is one of pg-mem's divergences: it hands back the literal
    // "{}" where node-postgres parses an empty array. That divergence is the
    // reason MaterialsService normalises on the way out too, so testing the
    // value the API would actually return is the honest assertion here.
    expect(normaliseExamples(row.examples)).toEqual([]);
  });

  /**
   * Idempotent by design: the migration must survive being applied to a database
   * where an operator has already created one of the seed codes by hand.
   */
  it("can be applied twice without failing on the seed inserts", async () => {
    const runner = dataSource.createQueryRunner();
    try {
      // The table already exists, so only the seeding half can run; it must not
      // raise on the conflict.
      for (const seed of SEED_MATERIALS) {
        await dataSource.query(
          `INSERT INTO "materials" ("code", "name", "active", "sortOrder")
           VALUES ($1, $2, $3, $4) ON CONFLICT ("code") DO NOTHING`,
          [seed.code, seed.name, seed.active, seed.sortOrder],
        );
      }
    } finally {
      await runner.release();
    }

    const petRows = await dataSource
      .getRepository(MaterialEntity)
      .findBy({ code: "PET" });
    expect(petRows).toHaveLength(1);
  });
});
