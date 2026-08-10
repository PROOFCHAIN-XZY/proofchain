import { describe, expect, it } from "vitest";
import type { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { RateLimit, RateLimitGuard, RateLimitExceededException } from "../src/common/rate-limit.guard";

/**
 * `POST /events` is public by design (the device signature is the
 * credential), which means it is reachable by anyone on the network, not
 * just enrolled devices. Without a cap, a flood of junk submissions still
 * costs two DB round trips each (device/collector/hub lookups + insert),
 * which is a real resource-exhaustion path against the evidentiary
 * database. These tests pin down the guard, independent of the rest of
 * Nest's DI wiring.
 */

class Probe {
  @RateLimit(2, 60)
  limited(): void {}

  unlimited(): void {}
}

function makeContext(handlerName: keyof Probe, ip: string): ExecutionContext {
  const proto = Probe.prototype;
  return {
    getHandler: () => proto[handlerName],
    getClass: () => Probe,
    switchToHttp: () => ({
      getRequest: () => ({ method: "POST", path: "/events", ip, socket: { remoteAddress: ip } }),
    }),
  } as unknown as ExecutionContext;
}

describe("RateLimitGuard", () => {
  it("allows requests under the limit", () => {
    const guard = new RateLimitGuard(new Reflector());
    const ctx = makeContext("limited", "203.0.113.10");

    expect(guard.canActivate(ctx)).toBe(true);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it("blocks the request that exceeds the configured limit within the window", () => {
    const guard = new RateLimitGuard(new Reflector());
    const ctx = makeContext("limited", "203.0.113.11");

    guard.canActivate(ctx);
    guard.canActivate(ctx);
    expect(() => guard.canActivate(ctx)).toThrow(RateLimitExceededException);
  });

  it("tracks separate IPs independently — one flooding source cannot lock out another", () => {
    const guard = new RateLimitGuard(new Reflector());
    const attacker = makeContext("limited", "203.0.113.12");
    const legitimate = makeContext("limited", "203.0.113.13");

    guard.canActivate(attacker);
    guard.canActivate(attacker);
    expect(() => guard.canActivate(attacker)).toThrow(RateLimitExceededException);

    // A different source IP still has its own untouched bucket.
    expect(guard.canActivate(legitimate)).toBe(true);
  });

  it("is a no-op on routes without @RateLimit — opt-in, not a blanket throttle", () => {
    const guard = new RateLimitGuard(new Reflector());
    const ctx = makeContext("unlimited", "203.0.113.14");

    for (let i = 0; i < 100; i += 1) {
      expect(guard.canActivate(ctx)).toBe(true);
    }
  });
});
