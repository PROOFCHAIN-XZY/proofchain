import { newDb, type IMemoryDb } from "pg-mem";
import { DataSource } from "typeorm";
import { randomUUID } from "node:crypto";
import { ALL_ENTITIES } from "../../src/database/entities";

/**
 * An in-process Postgres for service tests.
 *
 * The services under test push their hardest invariants down into the database
 * — `IsNull()` eligibility filters, the unique index on payloadHash that is the
 * real replay defence, transactional seals — so testing them against mocked
 * repositories would assert on the mocks rather than on the behaviour that
 * ships. pg-mem gives real SQL without a Docker daemon, so the same suite runs
 * locally and in CI.
 *
 * Known divergences from a real Postgres, and why they are acceptable here:
 *  - `SELECT ... FOR UPDATE` parses but does not block. Lock *ordering* is
 *    therefore untestable; the guard clauses the lock protects are not.
 *  - Each call gets a private database, so tests never share state.
 */
export interface TestDatabase {
  dataSource: DataSource;
  /** Truncate every table without paying to rebuild the schema. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

function registerPostgresShims(db: IMemoryDb): void {
  // TypeORM probes the server on connect; pg-mem ships neither function.
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

  // The entities default their primary keys to uuid_generate_v4(), which lives
  // in the uuid-ossp extension the real migration enables.
  db.registerExtension("uuid-ossp", (schema) => {
    schema.registerFunction({
      name: "uuid_generate_v4",
      returns: "uuid" as never,
      implementation: () => randomUUID(),
      impure: true,
    });
  });
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const db = newDb({ autoCreateForeignKeyIndices: true });
  registerPostgresShims(db);

  const dataSource: DataSource = await db.adapters.createTypeormDataSource({
    type: "postgres",
    entities: ALL_ENTITIES,
  });

  await dataSource.initialize();
  await dataSource.synchronize();

  // Snapshot the empty schema so reset() is a restore rather than a rebuild;
  // synchronize() dominates the runtime of a suite that resets per test.
  const empty = db.backup();

  return {
    dataSource,
    async reset() {
      empty.restore();
    },
    async close() {
      await dataSource.destroy();
    },
  };
}
