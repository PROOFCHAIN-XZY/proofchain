import { resolvePostgresConnection, type PostgresConnection } from "../database/postgres-connection";
import { parseTrustProxy, type TrustProxySetting } from "./trust-proxy";

export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  port: number;
  /** Connection URL plus the resolved TLS settings; see postgres-connection.ts. */
  database: PostgresConnection;
  jwtSecret: string;
  jwtExpiresIn: string;
  corsOrigins: string[];
  /**
   * How many proxies sit in front of this service, if any. Decides whether
   * `req.ip` — and therefore every rate limit — reflects the real client.
   * See config/trust-proxy.ts.
   */
  trustProxy: TrustProxySetting;
  photoStorageDir: string;
  maxClockSkewSeconds: number;
  stellarNetwork: "testnet" | "public";
  /**
   * Shared secret the anchor worker presents when writing back a Stellar
   * transaction to a sealed batch. `POST /batches/:id/anchor` cannot require a
   * human JWT (the worker is a machine with no operator session), but it must
   * not be reachable by an anonymous caller either: an unauthenticated writer
   * could plant a fabricated Stellar tx hash on a sealed batch, and that lie
   * would flow straight into the audit report sold to buyers. This token is
   * the credential that makes the endpoint "public to the worker", not
   * "public to the internet".
   */
  anchorWorkerToken: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable: ${name}`);
  return value;
}

/**
 * Fail fast at boot on missing configuration rather than at the first request.
 * The JWT secret is deliberately not defaulted in production — a shipped default
 * signing key is an authentication bypass, not a convenience.
 */
export function loadConfig(): AppConfig {
  const nodeEnv = (process.env.NODE_ENV ?? "development") as AppConfig["nodeEnv"];
  const isProduction = nodeEnv === "production";

  const jwtSecret = isProduction ? required("JWT_SECRET") : (process.env.JWT_SECRET ?? "dev-secret");
  if (isProduction && jwtSecret === "change-me-in-production") {
    throw new Error("JWT_SECRET is still the placeholder value; set a real secret");
  }

  // Same "fail fast, no shipped default" reasoning as JWT_SECRET: a default
  // anchor-worker token in production would let anyone forge anchor records.
  const anchorWorkerToken = isProduction
    ? required("ANCHOR_WORKER_TOKEN")
    : (process.env.ANCHOR_WORKER_TOKEN ?? "dev-anchor-worker-token");

  return {
    nodeEnv,
    port: Number(process.env.PORT ?? 3000),
    database: resolvePostgresConnection(),
    jwtSecret,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "12h",
    corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:3001")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    photoStorageDir: process.env.PHOTO_STORAGE_DIR ?? "./var/photos",
    maxClockSkewSeconds: Number(process.env.MAX_CLOCK_SKEW_SECONDS ?? 900),
    stellarNetwork: (process.env.STELLAR_NETWORK ?? "testnet") as AppConfig["stellarNetwork"],
    anchorWorkerToken,
  };
}
