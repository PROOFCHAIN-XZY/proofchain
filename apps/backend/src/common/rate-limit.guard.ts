import {
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";

/** 429 Too Many Requests — @nestjs/throttler is not a dependency here, so this
 *  is a minimal standalone equivalent rather than pulling in the package for
 *  one exception class. */
export class RateLimitExceededException extends HttpException {
  constructor(message: string) {
    super(message, HttpStatus.TOO_MANY_REQUESTS);
  }
}

/**
 * Rate limiting — deliberately opt-in via `@RateLimit(...)`, not a blanket
 * global limiter. The ones that matter here are the endpoints reachable
 * without a credential check that costs an attacker anything:
 *
 *  - `POST /events` is public by design (the device signature IS the auth),
 *    which means anyone who can reach the network can hit it. Without a
 *    limit, a single script can flood the ingest pipeline: every request
 *    still does two DB round trips (lookups + insert) even when it is
 *    rejected by integrity checks, so this is a real resource-exhaustion
 *    vector against the evidentiary database, not just noise.
 *  - `POST /auth/login` already equalises timing between "no such user" and
 *    "wrong password" (see AuthService.validate), but with no request cap an
 *    attacker can still brute-force a weak operator password at network
 *    speed; the timing fix alone does not slow them down.
 *
 * Implementation notes:
 *  - In-memory, per-process. Good enough for a single-instance MVP; a
 *    horizontally-scaled deployment needs a shared store (Redis) instead —
 *    called out here rather than silently left as a false sense of safety.
 *  - Keyed by `route:ip`. `req.ip` reflects Express's trust-proxy setting;
 *    behind a load balancer, `app.set('trust proxy', ...)` must be
 *    configured in main.ts or every request will appear to come from the
 *    proxy's address and share one bucket.
 */

export const RATE_LIMIT_KEY = "rateLimit";

export interface RateLimitOptions {
  /** Maximum requests allowed within the window. */
  limit: number;
  /** Sliding window size, in seconds. */
  windowSeconds: number;
}

export const RateLimit = (limit: number, windowSeconds: number): MethodDecorator =>
  SetMetadata(RATE_LIMIT_KEY, { limit, windowSeconds } satisfies RateLimitOptions);

interface Bucket {
  count: number;
  resetAt: number;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const options = this.reflector.getAllAndOverride<RateLimitOptions | undefined>(
      RATE_LIMIT_KEY,
      [context.getHandler(), context.getClass()],
    );
    // No @RateLimit on this route: this guard has nothing to enforce here.
    if (!options) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const key = `${request.method} ${request.route?.path ?? request.path}:${clientIp(request)}`;
    const now = Date.now();

    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + options.windowSeconds * 1000 });
      this.maybeEvictExpired(now);
      return true;
    }

    if (existing.count >= options.limit) {
      throw new RateLimitExceededException(
        `rate limit exceeded: max ${options.limit} requests per ${options.windowSeconds}s`,
      );
    }

    existing.count += 1;
    return true;
  }

  /**
   * Opportunistic cleanup so the bucket map cannot grow unbounded under a
   * distributed-source flood (many distinct IPs, each making one request).
   * Runs on a small fraction of requests rather than on every one, to avoid
   * turning a flood into an O(n) scan on every single request during it.
   */
  private maybeEvictExpired(now: number): void {
    if (this.buckets.size < 10_000 || Math.random() > 0.01) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

function clientIp(request: Request): string {
  return request.ip ?? request.socket.remoteAddress ?? "unknown";
}
