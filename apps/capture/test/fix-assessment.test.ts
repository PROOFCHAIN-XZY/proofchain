import { describe, expect, it } from "vitest";
import { assessFix, type HubContext } from "../src/lib/fix-assessment";
import type { Fix } from "../src/lib/location";

/**
 * This decides what is allowed to become signed evidence. A fix accepted here is
 * one a buyer may later be asked to trust, so the boundaries are pinned tightly.
 */

const NAIROBI: HubContext = {
  hubName: "Nairobi Pilot Hub",
  hubLat: -1.286389,
  hubLng: 36.817223,
  geofenceRadiusM: 300,
};

function fix(over: Partial<Fix> = {}): Fix {
  return {
    lat: NAIROBI.hubLat,
    lng: NAIROBI.hubLng,
    accuracyM: 12,
    at: "2026-08-09T10:00:00.000Z",
    ...over,
  };
}

describe("a good fix at the hub", () => {
  it("is accepted silently", () => {
    const result = assessFix(fix(), NAIROBI);

    expect(result.usable).toBe(true);
    expect(result.message).toBeNull();
  });

  it("is accepted anywhere inside the fence", () => {
    // ~200 m north of the hub: 0.0018 degrees of latitude.
    const result = assessFix(fix({ lat: NAIROBI.hubLat + 0.0018 }), NAIROBI);

    expect(result.usable).toBe(true);
  });
});

describe("accuracy wider than the geofence", () => {
  it("is refused, because it cannot place anyone inside the fence", () => {
    const result = assessFix(fix({ accuracyM: 301 }), NAIROBI);

    expect(result.usable).toBe(false);
    expect(result.message).toMatch(/wider than the 300 m hub geofence/);
  });

  it("refuses the desktop IP-geolocation case outright", () => {
    // What a laptop without GPS actually reports: hundreds of kilometres.
    const result = assessFix(fix({ accuracyM: 324_620 }), NAIROBI);

    expect(result.usable).toBe(false);
    expect(result.message).toMatch(/325 km/);
  });

  it("accepts an accuracy exactly at the fence radius", () => {
    expect(assessFix(fix({ accuracyM: 300 }), NAIROBI).usable).toBe(true);
  });
});

describe("a position outside the geofence", () => {
  it("is refused, and names the distance the collector must close", () => {
    // Abuja, Nigeria — roughly 3,449 km from Nairobi.
    const result = assessFix(fix({ lat: 9.06035, lng: 7.46783, accuracyM: 20 }), NAIROBI);

    expect(result.usable).toBe(false);
    expect(result.message).toMatch(/3449 km|3,449 km/);
    expect(result.message).toMatch(/Nairobi Pilot Hub/);
  });

  it("gives the benefit of the doubt when the error radius still reaches the fence", () => {
    // 400 m away but ±200 m: the collector may genuinely be inside.
    const result = assessFix(fix({ lat: NAIROBI.hubLat + 0.0036, accuracyM: 200 }), NAIROBI);

    expect(result.usable).toBe(true);
  });
});

describe("a mediocre but usable fix", () => {
  it("is accepted with a warning rather than blocked", () => {
    const result = assessFix(fix({ accuracyM: 150 }), NAIROBI);

    expect(result.usable).toBe(true);
    expect(result.message).toMatch(/usable, but move into the open/);
  });

  it("says nothing when accuracy is comfortably inside a third of the fence", () => {
    expect(assessFix(fix({ accuracyM: 99 }), NAIROBI).message).toBeNull();
  });
});

describe("before enrolment", () => {
  it("cannot judge a fix with no hub, and does not pretend to", () => {
    const result = assessFix(fix({ accuracyM: 5000 }), null);

    expect(result.usable).toBe(true);
    expect(result.message).toBeNull();
  });
});
