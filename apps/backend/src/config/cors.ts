/**
 * Which browser origins may call this API.
 *
 * Production uses an explicit allowlist and nothing else — this API serves the
 * evidence behind saleable credits, so a permissive rule there would let any
 * page a signed-in operator visits drive it with their cookies.
 *
 * Development is deliberately looser, for a concrete reason: the capture PWA is
 * a *field* app, and the only honest way to test it is on a real phone, which
 * reaches this machine over the LAN on a DHCP address that changes. A fixed
 * allowlist makes that a config edit every time, and the failure it produces —
 * an opaque "Failed to fetch" with no server-side log — costs far more time than
 * it saves. So in development we accept loopback and private-network origins on
 * any port, and nothing else: still not a wildcard, and never public addresses.
 */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** RFC 1918 ranges plus link-local — the addresses a phone on the office wifi gets. */
function isPrivateHost(host: string): boolean {
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

export function isLocalNetworkOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  // Only plain HTTP over a local network; anything else should be on the list.
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;

  const host = url.hostname;
  return LOOPBACK_HOSTS.has(host) || isPrivateHost(host);
}

/**
 * `origin` is undefined for same-origin requests, curl, and server-to-server
 * calls. Those carry no browser credentials, so there is nothing for CORS to
 * protect and blocking them would only break the anchor worker and health checks.
 */
export function isAllowedOrigin(
  origin: string | undefined,
  allowlist: readonly string[],
  isProduction: boolean,
): boolean {
  if (!origin) return true;
  if (allowlist.includes(origin)) return true;
  if (isProduction) return false;
  return isLocalNetworkOrigin(origin);
}
