import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NominatimClient } from "../src/collectors/nominatim.client";
import { stubRequiredEnv } from "./support/services";

/**
 * The client's job is to turn a coordinate into a short human label, and to be
 * unable to break anything when it fails. Most of these tests are about the
 * second half: every failure mode must come back as an absent label rather than
 * an exception, because the caller is creating a hub and the label is decoration.
 */

const NOMINATIM = "https://nominatim.example";
const USER_AGENT = "proofchain-test/0.1 (ops@example.org)";

/** Nairobi, matching the seed hub. */
const LAT = -1.286389;
const LNG = 36.817223;

let client: NominatimClient;

/** A trimmed copy of a real jsonv2 reverse response. */
function place(address: Record<string, string>, overrides: Record<string, unknown> = {}) {
  return {
    place_id: 123,
    licence: "Data © OpenStreetMap contributors, ODbL 1.0.",
    display_name: "12, Kenyatta Avenue, Central Business District, Nairobi, Kenya",
    address,
    ...overrides,
  };
}

function respondWith(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(typeof body === "string" ? body : JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        }),
    ),
  );
}

beforeEach(() => {
  stubRequiredEnv({
    NOMINATIM_URL: NOMINATIM,
    NOMINATIM_USER_AGENT: USER_AGENT,
    NOMINATIM_TIMEOUT_MS: "1000",
  });
  client = new NominatimClient();
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.NOMINATIM_USER_AGENT;
});

describe("NominatimClient label building", () => {
  it("builds a short locality label and drops the street detail", async () => {
    respondWith(
      place({
        road: "Kenyatta Avenue",
        suburb: "Central Business District",
        city: "Nairobi",
        state: "Nairobi County",
        country: "Kenya",
        country_code: "ke",
      }),
    );

    const result = await client.reverseGeocode(LAT, LNG);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The house number and road are exactly what a hub label must not carry:
    // they describe one doorway, not the collection area the geofence covers.
    expect(result.value.label).toBe("Nairobi, Nairobi County, Kenya");
  });

  it("falls back through town, village and county when city is absent", async () => {
    respondWith(place({ village: "Kongowea", county: "Mombasa", country: "Kenya" }));

    const result = await client.reverseGeocode(LAT, LNG);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.label).toBe("Kongowea, Mombasa, Kenya");
  });

  it("does not repeat a name that appears as both locality and region", async () => {
    respondWith(place({ city: "Kaduna", state: "Kaduna", country: "Nigeria" }));

    const result = await client.reverseGeocode(LAT, LNG);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.label).toBe("Kaduna, Nigeria");
  });

  it("uses the district when OSM has no city, town or village", async () => {
    // A verbatim address block from the live service for 9.0567, 7.4969 (Abuja).
    // Real data, kept because it is the case the first key list got wrong: this
    // coordinate has no city/town/village at all, and preferring `county` over
    // `district` dropped the only name a person would recognise.
    respondWith(
      place({
        district: "Central Business District",
        county: "Municipal Area Council",
        state: "Federal Capital Territory",
        postcode: "223140",
        country: "Nigeria",
        country_code: "ng",
      }),
    );

    const result = await client.reverseGeocode(LAT, LNG);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.label).toBe(
      "Central Business District, Federal Capital Territory, Nigeria",
    );
  });

  it("keeps the OSM attribution, which the licence requires us to display", async () => {
    respondWith(place({ city: "Nairobi", country: "Kenya" }));

    const result = await client.reverseGeocode(LAT, LNG);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.attribution).toContain("OpenStreetMap");
  });

  it("reports a country-only answer rather than inventing a locality", async () => {
    respondWith(place({ country: "Kenya", country_code: "ke" }));

    const result = await client.reverseGeocode(LAT, LNG);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.label).toBe("Kenya");
  });
});

describe("NominatimClient request shape", () => {
  it("identifies itself and asks for locality-level detail", async () => {
    respondWith(place({ city: "Nairobi", country: "Kenya" }));

    await client.reverseGeocode(LAT, LNG);

    const fetchMock = vi.mocked(fetch);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];

    expect(url).toContain(`${NOMINATIM}/reverse`);
    expect(url).toContain("format=jsonv2");
    // zoom=10 is the locality band. Higher zooms return street addresses, which
    // would imply a precision the hub coordinate does not have.
    expect(url).toContain("zoom=10");
    expect(url).toContain(`lat=${LAT.toFixed(4)}`);
    expect(url).toContain(`lon=${LNG.toFixed(4)}`);

    const headers = new Headers(init.headers);
    expect(headers.get("user-agent")).toBe(USER_AGENT);
  });

  it("quantises the coordinate it sends to the precision a locality needs", async () => {
    respondWith(place({ city: "Nairobi", country: "Kenya" }));

    await client.reverseGeocode(-1.2863891234, 36.8172231234);

    const [url] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    // Sending full device precision to a third party leaks a collector's exact
    // standing position for no gain — locality lookups are unaffected at 4dp.
    expect(url).toContain("lat=-1.2864");
    expect(url).toContain("lon=36.8172");
  });
});

describe("NominatimClient forward geocoding", () => {
  /** A trimmed /search result, as the live service returns them. */
  function searchHit(overrides: Record<string, unknown> = {}) {
    return [
      {
        place_id: 999,
        licence: "Data © OpenStreetMap contributors, ODbL 1.0.",
        lat: "-0.6698",
        lon: "34.7675",
        display_name: "Kisii, Kisii County, Nyanza, Kenya",
        ...overrides,
      },
    ];
  }

  it("resolves a place name to a coordinate and a label", async () => {
    respondWith(searchHit());

    const result = await client.forwardGeocode("Kisii, Kenya");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lat).toBeCloseTo(-0.6698, 4);
    expect(result.value.lng).toBeCloseTo(34.7675, 4);
    expect(result.value.label).toContain("Kisii");
  });

  it("confines the search to the pilot countries", async () => {
    respondWith(searchHit());

    await client.forwardGeocode("Lagos");

    const [url] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(url).toContain(`${NOMINATIM}/search`);
    // Without this, "Lagos" is as likely to return Portugal as Nigeria, and the
    // hub silently lands on another continent.
    expect(url).toContain("countrycodes=ke%2Cng");
    expect(url).toContain("limit=1");
  });

  it("reports an empty result as not_found rather than guessing", async () => {
    respondWith([]);

    const result = await client.forwardGeocode("nowhere at all");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_found");
  });

  it("rejects a hit whose coordinates are unparseable", async () => {
    respondWith(searchHit({ lat: "not-a-number" }));

    const result = await client.forwardGeocode("Kisii");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_found");
  });

  it("is disabled without a configured user agent", async () => {
    delete process.env.NOMINATIM_USER_AGENT;
    respondWith(searchHit());

    const result = await new NominatimClient().forwardGeocode("Kisii");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("disabled");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe("NominatimClient failure handling", () => {
  it("is disabled, and makes no request at all, without a configured user agent", async () => {
    delete process.env.NOMINATIM_USER_AGENT;
    const unidentified = new NominatimClient();
    respondWith(place({ city: "Nairobi", country: "Kenya" }));

    const result = await unidentified.reverseGeocode(LAT, LNG);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("disabled");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it("treats a 200 carrying an error body as no such place", async () => {
    // Nominatim answers unresolvable coordinates with HTTP 200 and an error key,
    // so status alone cannot be trusted to mean "this worked".
    respondWith({ error: "Unable to geocode" });

    const result = await client.reverseGeocode(LAT, LNG);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_found");
  });

  it("treats an empty address as no such place", async () => {
    respondWith(place({}));

    const result = await client.reverseGeocode(LAT, LNG);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_found");
  });

  it("reports a rate limit as unavailable, not as absence", async () => {
    respondWith("rate limited", 429);

    const result = await client.reverseGeocode(LAT, LNG);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unavailable");
    expect(result.detail).toContain("429");
  });

  it("reports a transport failure as unavailable rather than throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("The operation was aborted due to timeout");
      }),
    );

    const result = await client.reverseGeocode(LAT, LNG);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unavailable");
  });

  it("reports malformed JSON as unavailable rather than throwing", async () => {
    respondWith("<html>maintenance</html>");

    const result = await client.reverseGeocode(LAT, LNG);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unavailable");
  });

  it("rejects an out-of-range coordinate before spending a request", async () => {
    respondWith(place({ city: "Nairobi", country: "Kenya" }));

    const result = await client.reverseGeocode(91, 0);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_found");
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
