import { Injectable, Logger, Optional } from "@nestjs/common";
import { isValidLatLng } from "@proofchain/shared";
import { PILOT_COUNTRY_CODES } from "../database/hub-locations";
import { loadConfig } from "../config/configuration";

/**
 * Reverse geocoding against Nominatim (OpenStreetMap).
 *
 * Scoped to hubs, not events. Every event that passes integrity is inside its
 * hub's geofence — 250 m by default — and at that scale a geocoder returns the
 * same locality for all of them, so one lookup per hub row answers the question
 * for every weigh-in ever taken there. That is what keeps this within OSM's
 * 1 req/s policy without a rate limiter, a queue or a cache table.
 *
 * The label it produces is presentation metadata and nothing else. It is never
 * added to the signed payload (whose field set is pinned by `schema`) and never
 * to a Merkle leaf: a report whose verification depended on a third party still
 * being reachable, and still returning a byte-identical string years later,
 * would not be independently verifiable. Coordinates remain the only spatial
 * fact the proof rests on.
 *
 * Like HorizonClient, every failure is reported rather than thrown. The caller
 * is enrolling a hub; a geocoder having a bad day must not fail that write.
 */

export interface ReverseGeocodeResult {
  /** Short locality label, e.g. "Kaduna, Nigeria". */
  label: string;
  /** ODbL requires the data source be credited wherever the label is shown. */
  attribution: string | null;
}

/** A place name resolved to a coordinate — the reverse direction. */
export interface ForwardGeocodeResult {
  lat: number;
  lng: number;
  /** The service's own display name for what it matched. */
  label: string;
  attribution: string | null;
}

/** Why a lookup produced no label. */
export type GeocodeFailure = "not_found" | "unavailable" | "disabled";

export type Geocoded<T> =
  { ok: true; value: T } | { ok: false; reason: GeocodeFailure; detail: string };

export type GeocodeResult = Geocoded<ReverseGeocodeResult>;

/**
 * The locality band. Zoom 10 returns towns and cities; the higher zooms return
 * street addresses, which would dress a GPS-derived hub centre up as a precision
 * it does not have.
 */
const LOCALITY_ZOOM = 10;

/**
 * ~11 m. Enough to land in the right town, and coarse enough that we are not
 * handing a third-party service the exact spot a collector stands at.
 */
const REQUEST_COORD_DECIMALS = 4;

/**
 * Most specific settlement name first; the first hit wins.
 *
 * `district` sits above `county` from real data, not from taste: Abuja's
 * 9.0567, 7.4969 comes back with no city, town or village — only
 * district="Central Business District" and county="Municipal Area Council".
 * Preferring the county there discards the one name a reader would recognise.
 */
const LOCALITY_KEYS = [
  "city",
  "town",
  "village",
  "municipality",
  "suburb",
  "city_district",
  "district",
  "county",
] as const;

/** The administrative area above the settlement. */
const REGION_KEYS = ["state", "province", "region", "county"] as const;

@Injectable()
export class NominatimClient {
  private readonly logger = new Logger(NominatimClient.name);
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly timeoutMs: number;

  /**
   * Overrides are for tests. `@Optional()` keeps Nest from trying to inject a
   * String for them at boot, which would make this provider unconstructable.
   */
  constructor(
    @Optional() baseUrl?: string,
    @Optional() userAgent?: string,
    @Optional() timeoutMs?: number,
  ) {
    const config = loadConfig();
    this.baseUrl = (baseUrl ?? config.nominatimUrl).replace(/\/+$/, "");
    this.userAgent = userAgent ?? config.nominatimUserAgent;
    this.timeoutMs = timeoutMs ?? config.nominatimTimeoutMs;
  }

  /** Whether lookups will be attempted at all. */
  get enabled(): boolean {
    return this.userAgent.length > 0;
  }

  async reverseGeocode(lat: number, lng: number): Promise<GeocodeResult> {
    // OSM's usage policy requires a real identifying User-Agent and blocks
    // generic ones. Refusing to call without it is the difference between a
    // missing label and getting the pilot's egress IP banned.
    if (!this.enabled) {
      return {
        ok: false,
        reason: "disabled",
        detail: "NOMINATIM_USER_AGENT is not set, so reverse geocoding is disabled",
      };
    }

    if (!isValidLatLng(lat, lng)) {
      return { ok: false, reason: "not_found", detail: `not a coordinate: ${lat}, ${lng}` };
    }

    const params = new URLSearchParams({
      lat: lat.toFixed(REQUEST_COORD_DECIMALS),
      lon: lng.toFixed(REQUEST_COORD_DECIMALS),
      format: "jsonv2",
      zoom: String(LOCALITY_ZOOM),
      addressdetails: "1",
    });
    const url = `${this.baseUrl}/reverse?${params.toString()}`;

    const read = await this.getJson<Record<string, unknown>>(url);
    if (!read.ok) return read;
    const body = read.value;

    // Nominatim answers an unresolvable coordinate with HTTP 200 and an error
    // key, so the status code alone cannot be read as success.
    if (typeof body.error === "string") {
      return { ok: false, reason: "not_found", detail: body.error };
    }

    const address =
      body.address !== null && typeof body.address === "object"
        ? (body.address as Record<string, unknown>)
        : {};

    const label = buildLabel(address);
    if (!label) {
      return { ok: false, reason: "not_found", detail: `no address parts at ${lat}, ${lng}` };
    }

    return {
      ok: true,
      value: {
        label,
        attribution: typeof body.licence === "string" ? body.licence : null,
      },
    };
  }

  /**
   * A place name to a coordinate — used when relocating a hub by name.
   *
   * Confined to the pilot countries, which is not a nicety: "Lagos" matches
   * Portugal as readily as Nigeria, and an unbounded search would let a typo
   * move a hub to another continent, where every weigh-in fails `geofence_ok`
   * for a reason invisible from the capture app.
   *
   * The coordinate it returns is a *starting point* for an operator to confirm,
   * never a survey. It sets where the geofence sits; it never enters a payload.
   */
  async forwardGeocode(query: string): Promise<Geocoded<ForwardGeocodeResult>> {
    if (!this.enabled) {
      return {
        ok: false,
        reason: "disabled",
        detail: "NOMINATIM_USER_AGENT is not set, so geocoding is disabled",
      };
    }

    const trimmed = query.trim();
    if (!trimmed) {
      return { ok: false, reason: "not_found", detail: "empty search" };
    }

    const params = new URLSearchParams({
      q: trimmed,
      format: "jsonv2",
      countrycodes: PILOT_COUNTRY_CODES.join(","),
      limit: "1",
    });
    const url = `${this.baseUrl}/search?${params.toString()}`;

    const read = await this.getJson<unknown>(url);
    if (!read.ok) return read;

    const hits = Array.isArray(read.value) ? read.value : [];
    const hit = hits[0] as Record<string, unknown> | undefined;
    if (!hit) {
      return {
        ok: false,
        reason: "not_found",
        detail: `no match for "${trimmed}" in ${PILOT_COUNTRY_CODES.join("/").toUpperCase()}`,
      };
    }

    // Nominatim serialises coordinates as strings here, unlike /reverse.
    const lat = Number(hit.lat);
    const lng = Number(hit.lon);
    if (!isValidLatLng(lat, lng)) {
      return {
        ok: false,
        reason: "not_found",
        detail: `match for "${trimmed}" had unusable coordinates`,
      };
    }

    return {
      ok: true,
      value: {
        lat,
        lng,
        label: typeof hit.display_name === "string" ? hit.display_name : trimmed,
        attribution: typeof hit.licence === "string" ? hit.licence : null,
      },
    };
  }

  /** Shared transport: reports every failure, throws none. */
  private async getJson<T>(url: string): Promise<Geocoded<T>> {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": this.userAgent },
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        // Includes 429. A rate limit says nothing about whether the place
        // exists, so it must not be recorded as absence — the backfill should
        // be able to retry it later and get a label.
        return { ok: false, reason: "unavailable", detail: `${url} returned ${response.status}` };
      }

      return { ok: true, value: (await response.json()) as T };
    } catch (error) {
      // Timeouts, DNS and TLS failures, and non-JSON bodies all land here.
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`nominatim read failed for ${url}: ${detail}`);
      return { ok: false, reason: "unavailable", detail };
    }
  }
}

function pick(address: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = address[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

/**
 * "Kaduna, Nigeria" rather than "12, Kenyatta Avenue, Central Business
 * District, Nairobi, Kenya".
 *
 * `display_name` is deliberately not used: it carries house number and road,
 * which describe one doorway rather than the area a hub's geofence covers.
 */
function buildLabel(address: Record<string, unknown>): string | null {
  const locality = pick(address, LOCALITY_KEYS);
  const region = pick(address, REGION_KEYS);
  const country = pick(address, ["country"]);

  const parts: string[] = [];
  for (const part of [locality, region, country]) {
    // A city inside a same-named state ("Kaduna, Kaduna, Nigeria") reads as a
    // bug to anyone looking at the report.
    if (part && !parts.includes(part)) parts.push(part);
  }

  return parts.length > 0 ? parts.join(", ") : null;
}
