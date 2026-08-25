import { describe, expect, it } from "vitest";
import {
  boundsForHub,
  hubChoices,
  hubLabel,
  mergeHubSnapshot,
  selectHub,
  type HubOption,
} from "../src/lib/hubs";

/**
 * Switching hubs rewrites the hub id that goes into the signed payload, so the
 * label on screen must always describe the id that will be signed. These tests
 * pin that invariant.
 */

const NAIROBI: HubOption = {
  id: "hub-nbo",
  code: "NBO-01",
  name: "Nairobi Pilot Hub",
};

const LAGOS: HubOption = {
  id: "hub-los",
  code: "LAG-01",
  name: "Lagos Pilot Hub",
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

describe("selectHub", () => {
  it("moves the label with the id", () => {
    const assignment = selectHub(HUBS, "hub-los");

    expect(assignment).toEqual({
      hubId: "hub-los",
      hubName: "LAG-01 — Lagos Pilot Hub",
    });
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
    expect(choices[0]).toMatchObject({ id: "hub-nbo" });
  });

  it("treats an empty snapshot the same as an absent one", () => {
    expect(hubChoices([], current)).toHaveLength(1);
  });
});

describe("mergeHubSnapshot", () => {
  const current = {
    hubId: "hub-nbo",
    hubName: "NBO-01 — Nairobi Pilot Hub",
  };

  it("adopts a freshly fetched directory", () => {
    const merged = mergeHubSnapshot(HUBS, current);

    expect(merged.hubs).toHaveLength(2);
    expect(merged.assignment).toBeNull();
  });

  it("re-points the device when its own hub was renamed", () => {
    // An operator renamed the site. The phone would otherwise keep showing a
    // label the operator has already changed.
    const renamed = [{ ...NAIROBI, name: "Nairobi Central Hub" }];

    const merged = mergeHubSnapshot(renamed, current);

    expect(merged.assignment).toMatchObject({ hubName: "NBO-01 — Nairobi Central Hub" });
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

describe("boundsForHub", () => {
  const withBounds: HubOption = { ...NAIROBI, minWeightKg: 0.5, maxWeightKg: 10_000 };

  it("returns the assigned hub's own bounds, not the first hub's", () => {
    // A phone that reads the wrong hub's ceiling is worse than one that reads
    // none: it would refuse weights this site accepts.
    const bounds = boundsForHub(
      [{ ...LAGOS, minWeightKg: 1, maxWeightKg: 50 }, withBounds],
      "hub-nbo",
    );

    expect(bounds).toEqual({ minKg: 0.5, maxKg: 10_000 });
  });

  it("reports unknown bounds for a snapshot taken before they were published", () => {
    expect(boundsForHub([NAIROBI], "hub-nbo")).toEqual({ minKg: null, maxKg: null });
  });

  it("reports unknown bounds for a hub the device does not hold", () => {
    expect(boundsForHub([withBounds], "hub-lagos")).toEqual({ minKg: null, maxKg: null });
  });
});
