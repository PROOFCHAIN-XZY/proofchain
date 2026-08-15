/**
 * How the backend connects to Postgres, in one place.
 *
 * The app (Nest's TypeORM factory) and the CLI (`data-source.ts`, which runs
 * migrations) each used to build their own options from `DATABASE_URL` alone.
 * That was fine against a Docker Postgres on loopback and fails against every
 * managed provider, all of which require TLS.
 *
 * ## Why the URL is rewritten rather than passed through
 *
 * TypeORM hands node-postgres BOTH `connectionString` and `ssl`. node-postgres
 * then does, in `ConnectionParameters`:
 *
 *     config = Object.assign({}, config, parse(config.connectionString))
 *
 * — the parsed connection string WINS. And `pg-connection-string` sets
 * `config.ssl = {}` whenever the URL carries any `sslmode`. So a Neon URL
 * (which always ends `?sslmode=require`) silently discards whatever `ssl` we
 * pass, and an operator who sets `DATABASE_SSL=no-verify` to get past a
 * self-signed certificate would watch it have no effect, with nothing logged.
 *
 * So the ssl-related query parameters are stripped from the URL here and the
 * decision is expressed once, in the `ssl` option. One source of truth, no
 * silently-ignored configuration.
 *
 * ## Why verification is on by default
 *
 * libpq's `sslmode=require` means "encrypt, but do not check who you are
 * talking to" — which stops passive sniffing and not an active attacker. This
 * database is the evidentiary record behind saleable credits, so `require` is
 * mapped to *verified* TLS instead. Neon, Supabase, RDS and Render all present
 * certificates from public CAs, so this simply works. A provider with a private
 * CA needs `DATABASE_SSL_CA`; a genuinely self-signed dev server needs an
 * explicit `DATABASE_SSL=no-verify`, which is a decision someone has to type.
 */

/** What node-postgres accepts as its `ssl` option. */
export type PostgresSslOption = false | { rejectUnauthorized: boolean; ca?: string };

export interface PostgresConnection {
  /** `DATABASE_URL` with every ssl-related query parameter removed. */
  url: string;
  ssl: PostgresSslOption;
}

/** Query parameters that would otherwise let the URL override `ssl`. */
const SSL_URL_PARAMS = [
  "ssl",
  "sslmode",
  "sslcert",
  "sslkey",
  "sslrootcert",
  "sslnegotiation",
  "uselibpqcompat",
];

/**
 * Hosts that are unreachable from outside the machine or the private network,
 * where requiring TLS would break `npm run db:up` for no security gain.
 */
function isLocalOrPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (host === "localhost" || host === "::1" || host.endsWith(".localhost")) return true;
  // Docker Compose and Render both address services by bare service name.
  if (!host.includes(".") && !/^\d/.test(host)) return true;
  // Render's private network; Fly's internal DNS.
  if (host.endsWith(".internal")) return true;

  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;

  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

function parseUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new Error(
      "DATABASE_URL is not a valid connection URL " +
        "(expected postgres://user:password@host:port/database)",
    );
  }
}

/**
 * The ssl setting an explicit `DATABASE_SSL` asks for.
 * Returns undefined when the variable is absent, so the caller can fall back.
 */
function sslFromEnvVar(value: string | undefined): PostgresSslOption | undefined {
  if (value === undefined || value.trim() === "") return undefined;

  switch (value.trim().toLowerCase()) {
    case "disable":
    case "off":
    case "false":
    case "0":
      return false;
    case "no-verify":
    case "allow":
    case "prefer":
      return { rejectUnauthorized: false };
    case "require":
    case "verify-ca":
    case "verify-full":
    case "on":
    case "true":
    case "1":
      return { rejectUnauthorized: true };
    default:
      throw new Error(
        `DATABASE_SSL is "${value}", which is not a recognised value. ` +
          `Use one of: disable, no-verify, require.`,
      );
  }
}

/** The ssl setting implied by an `sslmode` already in the URL. */
function sslFromUrlMode(mode: string | null): PostgresSslOption | undefined {
  if (mode === null) return undefined;

  switch (mode.toLowerCase()) {
    case "disable":
      return false;
    // "prefer" and "allow" mean TLS is optional and unverified. Treated as
    // unverified-but-on: downgrading to plaintext because the URL said "prefer"
    // would be a silent security regression.
    case "prefer":
    case "allow":
    case "no-verify":
      return { rejectUnauthorized: false };
    default:
      // require / verify-ca / verify-full, and anything unrecognised: verify.
      return { rejectUnauthorized: true };
  }
}

/**
 * Resolve the connection settings from the environment.
 *
 * Precedence, most explicit first:
 *   1. `DATABASE_SSL` — an operator overriding everything on purpose.
 *   2. `sslmode` in `DATABASE_URL` — what the provider's copy-paste string says.
 *   3. The host: loopback and private addresses off, everything else verified.
 */
export function resolvePostgresConnection(
  env: NodeJS.ProcessEnv = process.env,
): PostgresConnection {
  const rawUrl = env.DATABASE_URL;
  if (!rawUrl) throw new Error("missing required environment variable: DATABASE_URL");

  const parsed = parseUrl(rawUrl);
  const urlMode = parsed.searchParams.get("sslmode");

  for (const param of SSL_URL_PARAMS) parsed.searchParams.delete(param);

  const ssl =
    sslFromEnvVar(env.DATABASE_SSL) ??
    sslFromUrlMode(urlMode) ??
    (isLocalOrPrivateHost(parsed.hostname) ? false : { rejectUnauthorized: true });

  const ca = env.DATABASE_SSL_CA?.trim();
  if (ca) {
    if (ssl === false) {
      throw new Error(
        "DATABASE_SSL_CA is set but TLS is disabled — remove one or the other so the " +
          "intended behaviour is unambiguous.",
      );
    }
    // A supplied CA exists to be checked against; honouring it while leaving
    // verification off would make the setting decorative.
    return { url: parsed.toString(), ssl: { rejectUnauthorized: true, ca } };
  }

  return { url: parsed.toString(), ssl };
}
