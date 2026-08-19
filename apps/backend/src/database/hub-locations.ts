import { isValidLatLng } from "@proofchain/shared";

/**
 * Known collection sites across the pilot countries.
 *
 * The pilot spans Kenya and Nigeria, so a hub's coordinate is not a one-time
 * setting — it moves as sites are trialled. Typing decimals by hand is where
 * that goes wrong: a transposed pair puts the hub in the Gulf of Guinea, every
 * weigh-in is quarantined on `geofence_ok`, and the reason is invisible from the
 * app. Naming the sites removes that class of mistake for the places we actually
 * work in, and free-text lookup covers everywhere else.
 *
 * Coordinates are city-centre approximations, which is the right precision for
 * this purpose: they seed a geofence whose radius is measured in hundreds of
 * metres and which the operator sets deliberately. They are NOT survey data and
 * nothing in the proof path depends on them — a real hub's coordinate should be
 * taken on site, from a device, and set explicitly.
 */

export interface HubLocation {
  /** Stable lookup key, kebab-case. */
  key: string;
  name: string;
  /** ISO 3166-1 alpha-2, limited to the pilot countries. */
  country: "KE" | "NG";
  lat: number;
  lng: number;
}

export const HUB_LOCATIONS: readonly HubLocation[] = [
  // Kenya
  { key: "nairobi", name: "Nairobi", country: "KE", lat: -1.286389, lng: 36.817223 },
  { key: "mombasa", name: "Mombasa", country: "KE", lat: -4.043477, lng: 39.668206 },
  { key: "kisumu", name: "Kisumu", country: "KE", lat: -0.091702, lng: 34.767956 },
  { key: "nakuru", name: "Nakuru", country: "KE", lat: -0.303099, lng: 36.080026 },
  { key: "eldoret", name: "Eldoret", country: "KE", lat: 0.514277, lng: 35.269779 },
  { key: "thika", name: "Thika", country: "KE", lat: -1.03326, lng: 37.069328 },
  { key: "machakos", name: "Machakos", country: "KE", lat: -1.518506, lng: 37.266418 },
  { key: "malindi", name: "Malindi", country: "KE", lat: -3.219186, lng: 40.116944 },

  // Nigeria
  { key: "lagos", name: "Lagos", country: "NG", lat: 6.524379, lng: 3.379206 },
  { key: "abuja", name: "Abuja", country: "NG", lat: 9.057851, lng: 7.49523 },
  { key: "kano", name: "Kano", country: "NG", lat: 12.002179, lng: 8.591956 },
  { key: "ibadan", name: "Ibadan", country: "NG", lat: 7.377566, lng: 3.905997 },
  { key: "port-harcourt", name: "Port Harcourt", country: "NG", lat: 4.824167, lng: 7.033611 },
  { key: "kaduna", name: "Kaduna", country: "NG", lat: 10.526413, lng: 7.438808 },
  { key: "benin-city", name: "Benin City", country: "NG", lat: 6.33492, lng: 5.60356 },
  { key: "onitsha", name: "Onitsha", country: "NG", lat: 6.141245, lng: 6.80238 },
];

const COUNTRY_NAMES: Record<HubLocation["country"], string> = {
  KE: "Kenya",
  NG: "Nigeria",
};

/** ISO codes the free-text lookup is confined to, so a name cannot resolve abroad. */
export const PILOT_COUNTRY_CODES = ["ke", "ng"] as const;

const normalise = (value: string): string => value.trim().toLowerCase().replace(/\s+/g, " ");

/**
 * A catalogue site by key or display name, or null.
 *
 * Matching is deliberately strict about *which* place, and lenient only about
 * spelling: "Port Harcourt", "port-harcourt" and "PORT HARCOURT" are the same
 * site, while "Lagos, Portugal" is not Lagos, Nigeria and must not resolve.
 */
export function findHubLocation(query: string): HubLocation | null {
  const wanted = normalise(query);
  if (!wanted) return null;

  return (
    HUB_LOCATIONS.find(
      (site) =>
        site.key === wanted ||
        site.key.replace(/-/g, " ") === wanted ||
        normalise(site.name) === wanted,
    ) ?? null
  );
}

/** The catalogue, grouped by country, for `--list`. */
export function formatHubLocations(): string {
  const lines: string[] = [];

  for (const code of ["KE", "NG"] as const) {
    lines.push(`${COUNTRY_NAMES[code]}:`);
    for (const site of HUB_LOCATIONS.filter((s) => s.country === code)) {
      lines.push(`  ${site.key.padEnd(16)} ${site.name.padEnd(16)} ${site.lat}, ${site.lng}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/** What the operator asked for. */
export type RelocateTarget =
  | { kind: "list" }
  | { kind: "coordinate"; lat: number; lng: number; radiusM?: number; hubCode?: string }
  | { kind: "site"; site: HubLocation; radiusM?: number; hubCode?: string }
  | { kind: "query"; query: string; radiusM?: number; hubCode?: string };

const USAGE =
  "usage: hub:relocate <lat> <lng> [radiusM] [hubCode]\n" +
  '       hub:relocate <site|"Town, Country"> [radiusM] [hubCode]\n' +
  "       hub:relocate --list";

function parseRadius(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;

  const radius = Number(value);
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new Error(`bad radius: ${value}`);
  }
  return Math.round(radius);
}

/**
 * Decide whether the arguments name a coordinate, a known site, or free text.
 *
 * Pure, and tested, because this is the step that can put a hub in the wrong
 * country. The one case it refuses outright is a single numeric argument: that
 * is a half-typed coordinate, and passing it to a geocoder as a place name
 * would relocate the hub to whatever a search for "9.0567" returns.
 */
export function parseRelocateArgs(argv: readonly string[]): RelocateTarget {
  const args = argv.filter((a) => a.length > 0);
  if (args.length === 0) throw new Error(USAGE);

  if (args[0] === "--list" || args[0] === "-l") return { kind: "list" };

  const first = args[0]!;
  const looksNumeric = (value: string | undefined): boolean =>
    value !== undefined && value.trim() !== "" && Number.isFinite(Number(value));

  if (looksNumeric(first)) {
    if (!looksNumeric(args[1])) {
      throw new Error(`incomplete coordinate: got "${first}" with no longitude\n\n${USAGE}`);
    }

    const lat = Number(first);
    const lng = Number(args[1]);
    if (!isValidLatLng(lat, lng)) {
      throw new Error(`coordinates out of range: ${lat}, ${lng}`);
    }

    return {
      kind: "coordinate",
      lat,
      lng,
      radiusM: parseRadius(args[2]),
      hubCode: args[3],
    };
  }

  const radiusM = parseRadius(args[1]);
  const hubCode = args[2];

  const site = findHubLocation(first);
  if (site) return { kind: "site", site, radiusM, hubCode };

  return { kind: "query", query: first, radiusM, hubCode };
}
