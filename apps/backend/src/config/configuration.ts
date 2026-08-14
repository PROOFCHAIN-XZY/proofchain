export interface AppConfig {
  nodeEnv: "development" | "test" | "production";
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  corsOrigins: string[];
  photoStorageDir: string;
  maxClockSkewSeconds: number;
  stellarNetwork: "testnet" | "public";
  /**
   * Horizon endpoint the backend reads anchors back from.
   *
   * The anchor worker verifies a root against the ledger at write time, but
   * nothing re-checks it afterwards, so `GET /batches/:id/verify/:eventId`
   * has been proving a Merkle path against a root held in our own database —
   * exactly the thing a buyer is not supposed to have to trust. Reading it
   * back here is what makes the endpoint's claim falsifiable.
   */
  stellarHorizonUrl: string;
  /**
   * Ceiling on a Horizon read. Verification is a public, unauthenticated
   * endpoint; an unbounded upstream call there is a way to tie up a request
   * worker for as long as Horizon is slow.
   */
  horizonTimeoutMs: number;
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
    databaseUrl: required("DATABASE_URL"),
    jwtSecret,
    jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? "12h",
    corsOrigins: (process.env.CORS_ORIGINS ?? "http://localhost:3001")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    photoStorageDir: process.env.PHOTO_STORAGE_DIR ?? "./var/photos",
    maxClockSkewSeconds: Number(process.env.MAX_CLOCK_SKEW_SECONDS ?? 900),
    stellarNetwork: (process.env.STELLAR_NETWORK ?? "testnet") as AppConfig["stellarNetwork"],
    stellarHorizonUrl: process.env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org",
    horizonTimeoutMs: Number(process.env.HORIZON_TIMEOUT_MS ?? 8_000),
    anchorWorkerToken,
  };
}
