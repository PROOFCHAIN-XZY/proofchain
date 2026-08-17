import "reflect-metadata";
import { config as loadDotenv } from "dotenv";
import { DataSource } from "typeorm";
import { ALL_ENTITIES } from "./entities";
import { resolvePostgresConnection } from "./postgres-connection";

loadDotenv();

// Migrations run against the same database, over the same TLS settings, as the
// app itself — a release step that could not reach a managed Postgres because
// only the app knew how to negotiate TLS would be a deploy-time surprise.
const connection = resolvePostgresConnection();

/**
 * Standalone DataSource for the TypeORM CLI (migrations). The running app builds
 * its own from Nest config; both must agree on entities and migration path.
 *
 * `synchronize` is never enabled. Schema changes go through reviewed migrations
 * because this database is the evidentiary record behind saleable credits.
 */
export const AppDataSource = new DataSource({
  type: "postgres",
  url: connection.url,
  ssl: connection.ssl,
  entities: ALL_ENTITIES,
  migrations: [`${__dirname}/migrations/*.{ts,js}`],
  synchronize: false,
  logging: process.env.TYPEORM_LOGGING === "true",
});
