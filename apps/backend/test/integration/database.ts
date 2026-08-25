import "reflect-metadata";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DataSource } from "typeorm";
import { SEED_MATERIALS } from "@proofchain/shared";
import { ALL_ENTITIES } from "../../src/database/entities";
import { InitialSchema1786190303177 } from "../../src/database/migrations/1786190303177-InitialSchema";
import { AnchorAttempts1786400000000 } from "../../src/database/migrations/1786400000000-AnchorAttempts";
import { HubLocality1786500000000 } from "../../src/database/migrations/1786500000000-HubLocality";
import { Materials1786600000000 } from "../../src/database/migrations/1786600000000-Materials";
import { MaterialExamples1786700000000 } from "../../src/database/migrations/1786700000000-MaterialExamples";
import { RemoveLocation1786800000000 } from "../../src/database/migrations/1786800000000-RemoveLocation";

/**
 * Migrations are listed as classes rather than as the `src/**\/migrations/*.ts`
 * glob the app uses. TypeORM resolves that glob with its own file loader, which
 * bypasses the test runner's TypeScript transform and fails on the first
 * type-only import it meets. Importing the classes keeps them on the normal
 * module path.
 *
 * The cost is that a new migration has to be added here too, so
 * `assertAllMigrationsRegistered` fails loudly when one is not — a test suite
 * quietly validating yesterday's schema is worse than one that will not start.
 */
const MIGRATIONS = [
  InitialSchema1786190303177,
  AnchorAttempts1786400000000,
  HubLocality1786500000000,
  Materials1786600000000,
  MaterialExamples1786700000000,
  RemoveLocation1786800000000,
];

function assertAllMigrationsRegistered(): void {
  const directory = join(__dirname, "../../src/database/migrations");
  const onDisk = readdirSync(directory).filter((file) => /\.ts$/.test(file));

  if (onDisk.length !== MIGRATIONS.length) {
    throw new Error(
      `${onDisk.length} migration file(s) on disk but ${MIGRATIONS.length} registered in ` +
        `test/integration/database.ts. Add the new migration class to MIGRATIONS so the ` +
        `integration tests run against the current schema.`,
    );
  }
}

/**
 * A real Postgres for the service-level tests.
 *
 * The batch services are not meaningfully testable against a mock: what they
 * actually promise is transactional — row locks that stop two concurrent seals
 * producing two roots, a unique index that is the authority on replay, `IsNull`
 * matching on a nullable FK, numeric columns that come back as strings unless
 * the transformer is right. A hand-written fake would assert that our mock
 * behaves like our mock. So these tests talk to the same engine production
 * does, with the same migrations applied.
 *
 * Its own database, never the development one: the suite truncates between
 * tests, and doing that to the database holding someone's seeded devices and
 * demo batches would be an unpleasant surprise.
 */

const DEFAULT_URL = "postgres://proofchain:proofchain@localhost:5433/proofchain_test";

export function testDatabaseUrl(): string {
  return process.env.TEST_DATABASE_URL ?? DEFAULT_URL;
}

/**
 * `CREATE DATABASE` cannot run inside the connection it creates, so this opens
 * a short-lived connection to the maintenance database first. Idempotent: on
 * every run after the first the database already exists.
 */
async function ensureDatabaseExists(url: string): Promise<void> {
  const parsed = new URL(url);
  const database = parsed.pathname.slice(1);

  const maintenanceUrl = new URL(url);
  maintenanceUrl.pathname = "/postgres";

  const admin = new DataSource({ type: "postgres", url: maintenanceUrl.toString() });
  await admin.initialize();
  try {
    const [existing] = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [
      database,
    ]);
    // Identifier interpolation, because Postgres does not accept a parameter
    // for a database name. `database` comes from our own env var, not a request.
    if (!existing) await admin.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`);
  } finally {
    await admin.destroy();
  }
}

/**
 * A connection refusal reaches us as an AggregateError — one sub-error per
 * address the host resolved to — and its own `message` is the empty string, so
 * reporting it alone ends the sentence on "Original error: ". The sub-errors
 * carry the part worth reading (ECONNREFUSED vs. ENOTFOUND vs. a password
 * rejection), so fall through to those.
 */
function describeError(error: unknown): string {
  const { message, code, errors } = (error ?? {}) as {
    message?: string;
    code?: string;
    errors?: unknown[];
  };
  if (message) return message;
  if (Array.isArray(errors) && errors.length > 0) {
    return [...new Set(errors.map(describeError))].join(", ");
  }
  return code ?? String(error);
}

export async function createTestDataSource(): Promise<DataSource> {
  const url = testDatabaseUrl();
  assertAllMigrationsRegistered();

  try {
    await ensureDatabaseExists(url);
  } catch (error) {
    // The most likely cause by far is "no Postgres running". Say so, with the
    // command that fixes it — a raw ECONNREFUSED stack sends people hunting
    // through the test code for a bug that is not there.
    throw new Error(
      `cannot reach Postgres at ${url} — start it with \`npm run db:up\` from the repo root, ` +
        `or point TEST_DATABASE_URL at your own instance. Original error: ${describeError(error)}`,
    );
  }

  const dataSource = new DataSource({
    type: "postgres",
    url,
    entities: ALL_ENTITIES,
    migrations: MIGRATIONS,
    synchronize: false,
    logging: false,
  });

  await dataSource.initialize();
  // The same migrations production runs — so a migration that drifts from the
  // entities fails here rather than on a deploy.
  await dataSource.runMigrations();
  await ensureCatalogueSeeded(dataSource);
  return dataSource;
}

/**
 * Put the seed catalogue back if it is missing.
 *
 * The Materials migration seeds it, but a migration runs once per database and
 * this database is long-lived and gets truncated between tests. A developer whose
 * `proofchain_test` was emptied by an older revision of the reset helper would
 * otherwise face every weigh-in failing with `unknown material "PET"` and no
 * obvious cause, fixable only by dropping the database by hand.
 *
 * Idempotent, and deliberately additive: it never removes or edits a row, so a
 * test that retires a material and forgets to restore it is still visible as a
 * failure rather than being papered over.
 */
async function ensureCatalogueSeeded(dataSource: DataSource): Promise<void> {
  for (const material of SEED_MATERIALS) {
    await dataSource.query(
      `INSERT INTO "materials" ("code", "name", "description", "active", "sortOrder")
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT ("code") DO NOTHING`,
      [material.code, material.name, material.description, material.active, material.sortOrder],
    );
  }
}

/**
 * Tables the migrations populate, which a reset must therefore leave alone.
 *
 * `materials` is reference data, not test fixtures: the Materials migration seeds
 * the catalogue, and ingest refuses a material the catalogue does not know.
 * Truncating it would leave every test facing an empty catalogue — a state a
 * migrated production database is never in — and every weigh-in would fail with
 * `unknown material "PET"`.
 */
const MIGRATION_SEEDED_TABLES = new Set(["materials"]);

/**
 * Empties every table between tests, except the ones the migrations seed.
 * CASCADE follows the foreign keys, and RESTART IDENTITY resets sequences, so
 * each test starts from the same place regardless of what ran before it.
 *
 * A test that needs to change the catalogue — retiring a material, say — should
 * put it back itself, exactly as it would have to in production.
 */
export async function resetTables(dataSource: DataSource): Promise<void> {
  const tables = ALL_ENTITIES.map((entity) => dataSource.getMetadata(entity).tableName)
    .filter((table) => !MIGRATION_SEEDED_TABLES.has(table))
    .map((table) => `"${table}"`)
    .join(", ");
  await dataSource.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
}
