import { describe, expect, it } from "vitest";
import {
  HUB_LOCATIONS,
  findHubLocation,
  formatHubLocations,
  parseRelocateArgs,
} from "../src/database/hub-locations";
import { isValidLatLng } from "@proofchain/shared";

/**
 * The pilot runs across Kenya and Nigeria, so moving a hub is routine rather
 * than exceptional. These tests cover the argument parsing that decides whether
 * the operator gave a coordinate, a known site, or free text — a misread there
 * silently relocates a hub to the wrong country, and every subsequent weigh-in
 * is quarantined for a reason nobody can see.
 */

describe("HUB_LOCATIONS catalogue", () => {
  it("covers both pilot countries", () => {
    const countries = new Set(HUB_LOCATIONS.map((l) => l.country));
    expect(countries).toEqual(new Set(["KE", "NG"]));
  });

  it("holds only valid coordinates, inside each country's rough bounds", () => {
    for (const site of HUB_LOCATIONS) {
      expect(isValidLatLng(site.lat, site.lng), `${site.key} coordinate`).toBe(true);

      // A transposed lat/lng is the classic silent error here, and it always
      // lands outside these envelopes.
      if (site.country === "KE") {
        expect(site.lat, `${site.key} lat`).toBeGreaterThan(-5);
        expect(site.lat, `${site.key} lat`).toBeLessThan(5.5);
        expect(site.lng, `${site.key} lng`).toBeGreaterThan(33.8);
        expect(site.lng, `${site.key} lng`).toBeLessThan(42);
      } else {
        expect(site.lat, `${site.key} lat`).toBeGreaterThan(4);
        expect(site.lat, `${site.key} lat`).toBeLessThan(14);
        expect(site.lng, `${site.key} lng`).toBeGreaterThan(2.6);
        expect(site.lng, `${site.key} lng`).toBeLessThan(14.7);
      }
    }
  });

  it("has unique keys, so a name can only mean one place", () => {
    const keys = HUB_LOCATIONS.map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("findHubLocation", () => {
  it("matches a key exactly", () => {
    expect(findHubLocation("nairobi")?.name).toBe("Nairobi");
    expect(findHubLocation("port-harcourt")?.country).toBe("NG");
  });

  it("is case and whitespace insensitive", () => {
    expect(findHubLocation("  NAIROBI ")?.key).toBe("nairobi");
  });

  it("accepts the display name and a spaced spelling of the key", () => {
    expect(findHubLocation("Port Harcourt")?.key).toBe("port-harcourt");
  });

  it("returns null for somewhere not in the catalogue", () => {
    expect(findHubLocation("kisii")).toBeNull();
    // Outside both pilot countries: must not silently resolve to anything.
    expect(findHubLocation("lagos, portugal")).toBeNull();
  });
});

describe("parseRelocateArgs", () => {
  it("reads a coordinate pair", () => {
    const parsed = parseRelocateArgs(["9.0567", "7.4969"]);
    expect(parsed).toMatchObject({ kind: "coordinate", lat: 9.0567, lng: 7.4969 });
  });

  it("carries the optional radius and hub code alongside a coordinate", () => {
    const parsed = parseRelocateArgs(["-1.2864", "36.8172", "500", "NBO-01"]);
    expect(parsed).toMatchObject({
      kind: "coordinate",
      radiusM: 500,
      hubCode: "NBO-01",
    });
  });

  it("recognises a catalogue site by name", () => {
    const parsed = parseRelocateArgs(["mombasa"]);
    expect(parsed.kind).toBe("site");
    if (parsed.kind !== "site") return;
    expect(parsed.site.name).toBe("Mombasa");
    expect(parsed.site.country).toBe("KE");
  });

  it("keeps radius and hub code after a site name", () => {
    const parsed = parseRelocateArgs(["kano", "800", "KAN-01"]);
    expect(parsed).toMatchObject({ kind: "site", radiusM: 800, hubCode: "KAN-01" });
  });

  it("treats an unknown multi-word name as free text to geocode", () => {
    const parsed = parseRelocateArgs(["Kisii, Kenya"]);
    expect(parsed).toMatchObject({ kind: "query", query: "Kisii, Kenya" });
  });

  it("asks for the list", () => {
    expect(parseRelocateArgs(["--list"]).kind).toBe("list");
  });

  it("rejects a half-given coordinate rather than guessing", () => {
    // "9.0567" alone is not a place and not a pair; treating it as free text
    // would send a bare number to a geocoder and relocate the hub to whatever
    // came back.
    expect(() => parseRelocateArgs(["9.0567"])).toThrow(/coordinate/i);
  });

  it("rejects an out-of-range coordinate", () => {
    expect(() => parseRelocateArgs(["91", "0"])).toThrow(/range/i);
  });

  it("rejects a non-positive radius", () => {
    expect(() => parseRelocateArgs(["nairobi", "0"])).toThrow(/radius/i);
  });

  it("rejects no arguments at all", () => {
    expect(() => parseRelocateArgs([])).toThrow(/usage/i);
  });
});

describe("formatHubLocations", () => {
  it("groups the catalogue by country for a readable listing", () => {
    const listing = formatHubLocations();
    expect(listing).toContain("Kenya");
    expect(listing).toContain("Nigeria");
    expect(listing).toContain("nairobi");
    expect(listing).toContain("lagos");
  });
});
