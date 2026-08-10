import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { UnauthorizedException, type ExecutionContext } from "@nestjs/common";

/**
 * POST /batches/:id/anchor is `@Public()` (skips the human JWT guard) because
 * the anchor worker is a headless service — but "public to the worker" must
 * not mean "public to the internet". Without `AnchorWorkerGuard`, anyone who
 * reads a batch's `merkleRoot` off the public audit report could forge a
 * Stellar tx hash and have it recorded as that batch's on-chain proof, which
 * flows straight into the report sold to a credit buyer. These tests pin
 * down the guard that closes that hole.
 */

function makeContext(headers: Record<string, string | undefined>): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers }),
    }),
  } as unknown as ExecutionContext;
}

describe("AnchorWorkerGuard", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.DATABASE_URL = "postgres://test";
    process.env.ANCHOR_WORKER_TOKEN = "correct-horse-battery-staple";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  async function loadGuard() {
    // Re-imported per test after env is set, since loadConfig() is read at
    // guard-construction time.
    const mod = await import("../src/auth/auth.module.js");
    return new mod.AnchorWorkerGuard();
  }

  it("rejects a request with no token header at all", async () => {
    const guard = await loadGuard();
    expect(() => guard.canActivate(makeContext({}))).toThrow(UnauthorizedException);
  });

  it("rejects a request with the wrong token — the fabricated-anchor scenario", async () => {
    const guard = await loadGuard();
    const attackerContext = makeContext({ "x-anchor-worker-token": "attacker-guess" });
    expect(() => guard.canActivate(attackerContext)).toThrow(UnauthorizedException);
  });

  it("rejects an empty-string token", async () => {
    const guard = await loadGuard();
    expect(() => guard.canActivate(makeContext({ "x-anchor-worker-token": "" }))).toThrow(
      UnauthorizedException,
    );
  });

  it("accepts the request when the shared secret matches exactly", async () => {
    const guard = await loadGuard();
    const context = makeContext({ "x-anchor-worker-token": "correct-horse-battery-staple" });
    expect(guard.canActivate(context)).toBe(true);
  });

  it("does not accept a token that is merely a prefix or suffix of the real one", async () => {
    const guard = await loadGuard();
    expect(() =>
      guard.canActivate(makeContext({ "x-anchor-worker-token": "correct-horse-battery-stapl" })),
    ).toThrow(UnauthorizedException);
    expect(() =>
      guard.canActivate(
        makeContext({ "x-anchor-worker-token": "correct-horse-battery-staple-extra" }),
      ),
    ).toThrow(UnauthorizedException);
  });
});
