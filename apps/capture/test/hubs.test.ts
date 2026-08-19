import { describe, expect, it } from "vitest";
import {
  fenceLabel,
  hubChoices,
  hubLabel,
  mergeHubSnapshot,
  selectHub,
  type HubOption,
} from "../src/lib/hubs";

/**
 * Switching hubs is the one control that can put a collector in the position of
 * being told they are in range while the server quarantines everything they
 * capture. These tests pin the invariant that prevents it: the id and the fence
 * always move together.
 */

const NAIROBI: HubOption = {
  id: "hub-nbo",
  code: "NBO-01",
  name: "Nairobi Pilot Hub",
  lat: -1.286389,
  lng: 36.817223,
  geofenceRadiusM: 300,
};

const LAGOS: HubOption = {
  id: "hub-los",
  code: "LAG-01",
  name: "Lagos Pilot Hub",
  lat: 6.524379,
  lng: 3.379206,
  geofenceRadiusM: 500,
};

const HUBS = [NAIROBI, LAGOS];

describe("hubLabel", () => {
  it("reads as the operator wrote it", () => {
    expect(hubLabel(LAGOS)).toBe("LAG-01 — Lagos Pilot Hub");
  });

  it("does not repeat a name that already carries its code", () => {
    // Provisioning stores hubName as "CODE — Name", so a synthesised option fed
    // both halves the same string once rendered as
    // "NBO-01 — Nairobi Pilot Hub — NBO-01 — Nairobi Pilot Hub".
    expect(hubLabel({ code: "", name: "NBO-01 — Nairobi Pilot Hub" })).toBe(
      "NBO-01 — Nairobi Pilot Hub",
    );
  });

  it("does not prefix a code the name already starts with", () => {
    expect(hubLabel({ code: "NBO-01", name: "NBO-01 — Nairobi Pilot Hub" })).toBe(
      "NBO-01 — Nairobi Pilot Hub",
    );
  });
});

describe("fenceLabel", () => {
  it("states the fence in metres", () => {
    expect(fenceLabel(300)).toBe("300 m fence");
  });

  it("says the fence is unknown rather than rendering NaN", () => {
    // A device provisioned by an older build has no geofenceRadiusM, and
    // Math.round(undefined) put "NaN m fence" on the collector's screen.
    expect(fenceLabel(undefined)).toBe("fence unknown");
    expect(fenceLabel(Number.NaN)).toBe("fence unknown");
    expect(fenceLabel(0)).toBe("fence unknown");
  });
});

describe("selectHub", () => {
  it("moves the coordinates and the fence with the id", () => {
    const assignment = selectHub(HUBS, "hub-los");

    expect(assignment).toEqual({
      hubId: "hub-los",
      hubName: "LAG-01 — Lagos Pilot Hub",
      hubLat: 6.524379,
      hubLng: 3.379206,
      geofenceRadiusM: 500,
    });
  });

  it("never leaves the fence behind when switching between countries", () => {
    // The failure this guards against: keeping Nairobi's 300 m fence while
    // signing Lagos's id. assessFix would judge a Lagos fix against a Kenyan
    // coordinate, tell the collector they are 3,800 km out, and be right for
    // the wrong reason — or worse, pass and let the server quarantine it.
    const assignment = selectHub(HUBS, "hub-los");

    expect(assignment?.geofenceRadiusM).toBe(LAGOS.geofenceRadiusM);
    expect(assignment?.hubLat).not.toBe(NAIROBI.lat);
  });

  it("returns null for a hub that is not in the snapshot", () => {
    expect(selectHub(HUBS, "hub-unknown")).toBeNull();
  });

  it("returns null against an empty snapshot rather than inventing a hub", () => {
    expect(selectHub([], "hub-nbo")).toBeNull();
  });
});

describe("hubChoices", () => {
  const current = {
    hubId: "hub-nbo",
    hubName: "NBO-01 — Nairobi Pilot Hub",
    hubLat: NAIROBI.lat,
    hubLng: NAIROBI.lng,
    geofenceRadiusM: 300,
  };

  it("offers the snapshot when it holds the assigned hub", () => {
    expect(hubChoices(HUBS, current).map((h) => h.id)).toEqual(["hub-nbo", "hub-los"]);
  });

  it("keeps the assigned hub visible when it is missing from the snapshot", () => {
    // A hub retired after this phone was enrolled. Dropping it would move the
    // select to another site without the collector touching anything.
    const choices = hubChoices([LAGOS], current);

    expect(choices.map((h) => h.id)).toContain("hub-nbo");
    expect(choices).toHaveLength(2);
  });

  it("synthesises a single choice for a device enrolled before snapshots existed", () => {
    const choices = hubChoices(undefined, current);

    expect(choices).toHaveLength(1);
    expect(choices[0]).toMatchObject({
      id: "hub-nbo",
      lat: NAIROBI.lat,
      geofenceRadiusM: 300,
    });
  });

  it("treats an empty snapshot the same as an absent one", () => {
    expect(hubChoices([], current)).toHaveLength(1);
  });
});

describe("mergeHubSnapshot", () => {
  const current = {
    hubId: "hub-nbo",
    hubName: "NBO-01 — Nairobi Pilot Hub",
    hubLat: NAIROBI.lat,
    hubLng: NAIROBI.lng,
    geofenceRadiusM: 300,
  };

  it("adopts a freshly fetched directory", () => {
    const merged = mergeHubSnapshot(HUBS, current);

    expect(merged.hubs).toHaveLength(2);
    expect(merged.assignment).toBeNull();
  });

  it("re-points the device when its own hub has moved", () => {
    // An operator ran hub:relocate. The phone would otherwise keep judging fixes
    // against a coordinate the hub no longer sits at.
    const moved = [{ ...NAIROBI, lat: 6.9, lng: 37.2, geofenceRadiusM: 450 }];

    const merged = mergeHubSnapshot(moved, current);

    expect(merged.assignment).toMatchObject({ hubLat: 6.9, geofenceRadiusM: 450 });
  });

  it("leaves the assignment alone when nothing about the hub changed", () => {
    const merged = mergeHubSnapshot([{ ...NAIROBI, id: "hub-nbo" }], current);
    expect(merged.assignment).toBeNull();
  });

  it("keeps the device usable when its hub is missing from the directory", () => {
    // Retired, or fetched from a different backend. Dropping the assignment
    // would leave the phone unable to sign anything.
    const merged = mergeHubSnapshot([LAGOS], current);

    expect(merged.hubs.map((h) => h.id)).toContain("hub-nbo");
    expect(merged.assignment).toBeNull();
  });

  it("ignores an empty directory rather than emptying the picker", () => {
    expect(mergeHubSnapshot([], current).hubs.map((h) => h.id)).toContain("hub-nbo");
  });
});
