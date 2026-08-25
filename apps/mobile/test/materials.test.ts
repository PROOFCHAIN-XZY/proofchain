import { beforeEach, describe, expect, it, vi } from "vitest";
import { SEED_MATERIALS, type Material } from "@shared/materials";
import { createMemoryStore, type KeyValueStore } from "../src/lib/storage";
import {
  fallbackCatalogue,
  loadCatalogue,
  reconcileSelection,
  refreshCatalogue,
} from "../src/lib/materials";

/**
 * The Expo counterpart to the PWA's catalogue tests, holding the same line: the
 * picker must always have something a collector can sign against, whatever the
 * network, the server or the cache is doing.
 */

const CATALOGUE_KEY = "proofchain.materials.v1";
const ORIGIN = "http://10.0.2.2:3000";

let store: KeyValueStore;

function material(overrides: Partial<Material> = {}): Material {
  return {
    code: "PET",
    name: "PET",
    description: null,
    examples: [],
    active: true,
    sortOrder: 10,
    ...overrides,
  };
}

async function writeCache(materials: Material[], origin = ORIGIN): Promise<void> {
  await store.setItem(
    CATALOGUE_KEY,
    JSON.stringify({ fetchedAt: new Date().toISOString(), origin, materials }),
  );
}

function respondWith(body: unknown, ok = true): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, json: async () => body }) as unknown as Response),
  );
}

beforeEach(() => {
  store = createMemoryStore();
  vi.unstubAllGlobals();
});

describe("fallbackCatalogue", () => {
  it("is never empty, which the picker relies on for its first frame", () => {
    const catalogue = fallbackCatalogue();

    expect(catalogue.pickable.length).toBeGreaterThan(0);
    expect(catalogue.isFallback).toBe(true);
    expect(catalogue.all.map((m) => m.code)).toEqual(SEED_MATERIALS.map((m) => m.code));
  });
});

describe("loadCatalogue", () => {
  it("uses the seed list when nothing is cached", async () => {
    const catalogue = await loadCatalogue(store, ORIGIN);

    expect(catalogue.isFallback).toBe(true);
    expect(catalogue.fetchedAt).toBeNull();
  });

  it("uses the cached list when there is one", async () => {
    await writeCache([material({ code: "PVC", name: "Pipe and profile" })]);

    const catalogue = await loadCatalogue(store, ORIGIN);

    expect(catalogue.isFallback).toBe(false);
    expect(catalogue.all.map((m) => m.code)).toEqual(["PVC"]);
    expect(catalogue.fetchedAt).not.toBeNull();
  });

  it("keeps retired entries out of the picker but available for labelling", async () => {
    await writeCache([material({ code: "PET" }), material({ code: "PS", active: false })]);

    const catalogue = await loadCatalogue(store, ORIGIN);

    expect(catalogue.pickable.map((m) => m.code)).toEqual(["PET"]);
    expect(catalogue.all.map((m) => m.code)).toContain("PS");
  });

  it("discards a cache written against a different backend", async () => {
    await writeCache([material({ code: "PVC" })], "https://other.example.com");

    const catalogue = await loadCatalogue(store, ORIGIN);

    expect(catalogue.isFallback).toBe(true);
  });

  it("survives a corrupted cache", async () => {
    await store.setItem(CATALOGUE_KEY, "{not json");

    const catalogue = await loadCatalogue(store, ORIGIN);

    expect(catalogue.isFallback).toBe(true);
    expect(catalogue.pickable.length).toBeGreaterThan(0);
  });

  it("never returns an empty picker even when every entry is retired", async () => {
    await writeCache([material({ code: "PET", active: false })]);

    const catalogue = await loadCatalogue(store, ORIGIN);

    expect(catalogue.pickable.length).toBeGreaterThan(0);
  });
});

describe("refreshCatalogue", () => {
  it("caches what the backend returns", async () => {
    respondWith([material({ code: "PVC", name: "Pipe and profile" })]);

    const catalogue = await refreshCatalogue(store, ORIGIN);

    expect(catalogue.all.map((m) => m.code)).toEqual(["PVC"]);
    expect(catalogue.isFallback).toBe(false);
  });

  it("returns the cached list when the request throws", async () => {
    await writeCache([material({ code: "PVC" })]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    const catalogue = await refreshCatalogue(store, ORIGIN);

    expect(catalogue.all.map((m) => m.code)).toEqual(["PVC"]);
  });

  it("refuses to blank the picker on an empty response", async () => {
    await writeCache([material({ code: "PVC" })]);
    respondWith([]);

    const catalogue = await refreshCatalogue(store, ORIGIN);

    expect(catalogue.all.map((m) => m.code)).toEqual(["PVC"]);
  });

  it("ignores a response that is not an array", async () => {
    respondWith({ message: "unauthorised" });

    const catalogue = await refreshCatalogue(store, ORIGIN);

    expect(catalogue.isFallback).toBe(true);
  });
});

describe("reconcileSelection", () => {
  it("keeps a selection that is still offered", async () => {
    await writeCache([material({ code: "PET" }), material({ code: "HDPE", sortOrder: 20 })]);
    const catalogue = await loadCatalogue(store, ORIGIN);

    expect(reconcileSelection(catalogue, "HDPE")).toBe("HDPE");
  });

  /**
   * An operator can retire the selected material while the capture screen sits
   * open. Leaving it selected would have the collector sign weigh-ins that are
   * accepted but can never be batched.
   */
  it("moves off a material that has just been retired", async () => {
    await writeCache([material({ code: "PET" }), material({ code: "PS", active: false })]);
    const catalogue = await loadCatalogue(store, ORIGIN);

    expect(reconcileSelection(catalogue, "PS")).toBe("PET");
  });

  it("picks the first offered material when nothing is selected yet", async () => {
    const catalogue = await loadCatalogue(store, ORIGIN);

    expect(reconcileSelection(catalogue, null)).toBe(catalogue.pickable[0].code);
  });

  it("moves off a code the catalogue has never heard of", async () => {
    await writeCache([material({ code: "PET" })]);
    const catalogue = await loadCatalogue(store, ORIGIN);

    expect(reconcileSelection(catalogue, "UNOBTANIUM")).toBe("PET");
  });
});
