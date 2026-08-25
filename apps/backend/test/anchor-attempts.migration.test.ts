import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newDb } from "pg-mem";
import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";
import { AnchorAttempts1786400000000 } from "../src/database/migrations/1786400000000-AnchorAttempts";
import { ALL_ENTITIES, AnchorAttemptEntity, BatchEntity, HubEntity } from "../src/database/entities";

/**
 * Runs the migration's own SQL and then uses the entity against it.
 *
 * The rest of the suite builds its schema from the entities via synchronize(),
 * which means it would pass just as happily against a migration that was never
 * written. Production runs the migration and never synchronizes, so a column
 * the entity expects and the migration does not create is a failure that only
 * appears on deploy — against the database holding the evidentiary record.
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
    // The whole set: BatchEntity's relations resolve only if every entity they
    // point at is registered.
    entities: ALL_ENTITIES,
  });
  await dataSource.initialize();

  // Only the tables this migration depends on are synchronised; anchor_attempts
  // itself must come from the migration, which is the point of the test.
  await dataSource.synchronize();
  // CASCADE so the synchronised indexes go with it; pg-mem otherwise leaves
  // them behind and the migration's CREATE INDEX collides.
  await dataSource.query(`DROP TABLE "anchor_attempts" CASCADE`);
  await dataSource.query(`DROP INDEX IF EXISTS "ix_anchor_attempt_batch_time"`);

  const runner = dataSource.createQueryRunner();
  await new AnchorAttempts1786400000000().up(runner);
  await runner.release();
});

afterAll(async () => {
  await dataSource?.destroy();
});

describe("AnchorAttempts migration", () => {
  it("creates a table the entity can be written through", async () => {
    const hub = await dataSource.getRepository(HubEntity).save({
      code: "HUB-MIG",
      name: "Migration Hub",
      minWeightKg: 0.1,
      maxWeightKg: 500,
    } as HubEntity);

    const batch = await dataSource.getRepository(BatchEntity).save({
      hubId: hub.id,
      material: "PET",
      status: "sealed",
      totalWeightKg: 5,
      eventCount: 1,
      merkleRoot: "a".repeat(64),
      sealedAt: new Date(),
    } as BatchEntity);

    const saved = await dataSource.getRepository(AnchorAttemptEntity).save({
      batchId: batch.id,
      attemptNumber: 1,
      outcome: "unverified",
      detail: "submitted but not confirmed on read-back",
      stellarTxHash: "d".repeat(64),
      occurredAt: new Date("2026-03-01T12:00:00.000Z"),
    } as AnchorAttemptEntity);

    // Every column the entity declares has to survive the round trip; a
    // mismatch here is the deploy-time failure this test exists to catch.
    const reloaded = await dataSource
      .getRepository(AnchorAttemptEntity)
      .findOneByOrFail({ id: saved.id });

    expect(reloaded.batchId).toBe(batch.id);
    expect(reloaded.attemptNumber).toBe(1);
    expect(reloaded.outcome).toBe("unverified");
    expect(reloaded.detail).toContain("not confirmed");
    expect(reloaded.stellarTxHash).toBe("d".repeat(64));
    expect(reloaded.occurredAt).toBeInstanceOf(Date);
    expect(reloaded.createdAt).toBeInstanceOf(Date);
  });

  it("defaults the nullable columns rather than requiring them", async () => {
    const batch = (await dataSource.getRepository(BatchEntity).find())[0]!;

    const saved = await dataSource.getRepository(AnchorAttemptEntity).save({
      batchId: batch.id,
      attemptNumber: 2,
      outcome: "failed",
      occurredAt: new Date(),
    } as AnchorAttemptEntity);

    // A plain failure carries neither detail nor a transaction hash, and the
    // migration must not have made either NOT NULL.
    expect(saved.detail ?? null).toBeNull();
    expect(saved.stellarTxHash ?? null).toBeNull();
  });
});
