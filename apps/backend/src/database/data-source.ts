import "reflect-metadata";
import { config as loadDotenv } from "dotenv";
import { DataSource } from "typeorm";
import { ALL_ENTITIES } from "./entities";

loadDotenv();

/**
 * Standalone DataSource for the TypeORM CLI (migrations). The running app builds
 * its own from Nest config; both must agree on entities and migration path.
 *
 * `synchronize` is never enabled. Schema changes go through reviewed migrations
 * because this database is the evidentiary record behind saleable credits.
 */
export const AppDataSource = new DataSource({
  type: "postgres",
  url: process.env.DATABASE_URL,
  entities: ALL_ENTITIES,
  migrations: [`${__dirname}/migrations/*.{ts,js}`],
  synchronize: false,
  logging: process.env.TYPEORM_LOGGING === "true",
});
