import "reflect-metadata";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DataSource } from "typeorm";
import { ALL_ENTITIES } from "../../src/database/entities";
import { InitialSchema1786190303177 } from "../../src/database/migrations/1786190303177-InitialSchema";

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
const MIGRATIONS = [InitialSchema1786190303177];

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
  return dataSource;
}

/**
 * Empties every table between tests. CASCADE follows the foreign keys, and
 * RESTART IDENTITY resets sequences, so each test starts from the same place
 * regardless of what ran before it.
 */
export async function resetTables(dataSource: DataSource): Promise<void> {
  const tables = ALL_ENTITIES.map(
    (entity) => `"${dataSource.getMetadata(entity).tableName}"`,
  ).join(", ");
  await dataSource.query(`TRUNCATE ${tables} RESTART IDENTITY CASCADE`);
}
