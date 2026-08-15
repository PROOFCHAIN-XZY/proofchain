/**
 * Express's `trust proxy` setting, resolved from `TRUST_PROXY`.
 *
 * ## Why this has to be configured at all
 *
 * `req.ip` is the socket's peer address unless Express is told to trust
 * `X-Forwarded-For`. Behind any load balancer — Render, Railway, Fly, an nginx
 * in front — that peer is the balancer, so *every* request arrives from one
 * address. The rate limiters on `POST /auth/login` and `POST /events` key on
 * `req.ip`, so they would put the entire internet in a single bucket: a brute
 * force against an operator password would be indistinguishable from ordinary
 * traffic, and would lock out every honest user instead of the attacker.
 *
 * ## Why it defaults to off
 *
 * The mirror-image failure is worse. `X-Forwarded-For` is a client-supplied
 * header. Trusting it on a server that is NOT behind a proxy lets an attacker
 * put a different fake address on every request and never share a bucket with
 * themselves — the rate limiter becomes decorative, and its logs name innocent
 * addresses. So trusting the header is opt-in: it is only correct when the
 * deployment topology guarantees a proxy is there, and only the person
 * deploying knows that.
 *
 * ## Choosing a value
 *
 *   TRUST_PROXY=1              one proxy in front (Render, Railway, Fly, Heroku)
 *   TRUST_PROXY=2              e.g. Cloudflare in front of a platform balancer
 *   TRUST_PROXY=loopback       a reverse proxy on the same host
 *   TRUST_PROXY=10.0.0.0/8     trust a named private range
 *   TRUST_PROXY=false          direct exposure, no proxy (the default)
 *
 * Prefer the hop count over `true`. `true` trusts the left-most entry of a
 * header the client wrote, which is the spoofable case above.
 */
export type TrustProxySetting = boolean | number | string;

export function parseTrustProxy(raw: string | undefined): TrustProxySetting {
  const value = raw?.trim();
  if (!value) return false;

  const lowered = value.toLowerCase();
  if (lowered === "false" || lowered === "off" || lowered === "no") return false;
  if (lowered === "true" || lowered === "on" || lowered === "yes") return true;

  // A hop count. Rejected rather than coerced when negative or fractional: "-1"
  // silently becoming "trust nothing" is the kind of quiet misconfiguration
  // this whole module exists to prevent.
  if (/^-?\d+(\.\d+)?$/.test(value)) {
    const hops = Number(value);
    if (!Number.isInteger(hops) || hops < 0) {
      throw new Error(
        `TRUST_PROXY is "${value}"; a numeric value must be a whole number of proxy hops (0, 1, 2, …)`,
      );
    }
    // 0 hops means "trust nothing", which Express spells as false.
    return hops === 0 ? false : hops;
  }

  // Anything else is handed to Express as a subnet list: "loopback",
  // "uniquelocal", or comma-separated addresses/CIDRs. Express validates it and
  // throws at startup if it is malformed, which is where we want to find out.
  return value;
}

/**
 * A warning to log at boot, or null when the setting looks right.
 * Returned rather than logged so this stays testable and the caller owns output.
 */
export function trustProxyWarning(
  setting: TrustProxySetting,
  isProduction: boolean,
): string | null {
  if (setting === true) {
    return (
      "TRUST_PROXY=true trusts the left-most X-Forwarded-For entry, which any client can " +
      "forge — an attacker can then evade the login and ingest rate limits by sending a " +
      "different fake address each request. Set it to the number of proxies in front of " +
      "this service instead (TRUST_PROXY=1 for Render, Railway, Fly or Heroku)."
    );
  }

  if (setting === false && isProduction) {
    return (
      "TRUST_PROXY is not set. If this service runs behind a load balancer, every request " +
      "appears to come from the balancer and the login and ingest rate limits share one " +
      "bucket for all clients. Set TRUST_PROXY=1 when a proxy is in front of it."
    );
  }

  return null;
}
