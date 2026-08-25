import { beforeEach, describe, expect, it, vi } from "vitest";
import { SEED_MATERIALS, type Material } from "@shared/materials";

/**
 * The device's copy of the catalogue.
 *
 * What matters here is not the happy path but every way the network can let a
 * collector down: no signal, a server that has not been migrated, a cache written
 * by a different backend, a corrupted entry. In each case the picker must still
 * render something a collector can sign against, because the alternative is a
 * person standing at a scale unable to record the sack in front of them.
 */

const store = new Map<string, string>();

vi.stubGlobal("localStorage", {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
});

const BACKEND = "http://localhost:3000";
vi.mock("../src/lib/api", () => ({ backendUrl: () => BACKEND }));

const { cachedCatalogue, catalogueFetchedAt, isUsingFallbackCatalogue, pickableMaterials, refreshCatalogue } =
  await import("../src/lib/materials");

const CATALOGUE_KEY = "proofchain.materials.v1";

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

function writeCache(materials: Material[], origin = BACKEND): void {
  store.set(
    CATALOGUE_KEY,
    JSON.stringify({ fetchedAt: new Date().toISOString(), origin, materials }),
  );
}

function respondWith(materials: unknown, ok = true): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok, json: async () => materials }) as unknown as Response),
  );
}

beforeEach(() => {
  store.clear();
  vi.unstubAllGlobals();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
});

describe("with no cache at all", () => {
  it("falls back to the codes compiled into the shared package", () => {
    expect(cachedCatalogue().map((m) => m.code)).toEqual(SEED_MATERIALS.map((m) => m.code));
  });

  it("says so, so the UI can flag the list as unsynced", () => {
    expect(isUsingFallbackCatalogue()).toBe(true);
    expect(catalogueFetchedAt()).toBeNull();
  });

  it("still offers a non-empty picker", () => {
    expect(pickableMaterials().length).toBeGreaterThan(0);
  });
});

describe("with a cached catalogue", () => {
  it("renders the operator's list, not the built-in one", () => {
    writeCache([material({ code: "PVC", name: "Pipe and profile" })]);

    expect(cachedCatalogue().map((m) => m.code)).toEqual(["PVC"]);
    expect(isUsingFallbackCatalogue()).toBe(false);
  });

  it("hides retired entries from the picker but keeps them for labelling", () => {
    writeCache([material({ code: "PET" }), material({ code: "PS", active: false })]);

    expect(pickableMaterials().map((m) => m.code)).toEqual(["PET"]);
    expect(cachedCatalogue().map((m) => m.code)).toContain("PS");
  });

  /**
   * A code valid on one instance may not exist on another. Carrying the cache
   * across would have the collector sign weigh-ins the new server rejects
   * outright.
   */
  it("ignores a cache written by a different backend", () => {
    writeCache([material({ code: "PVC" })], "https://other.example.com");

    expect(isUsingFallbackCatalogue()).toBe(true);
    expect(cachedCatalogue().map((m) => m.code)).toEqual(SEED_MATERIALS.map((m) => m.code));
  });

  it("survives a corrupted cache rather than throwing at render time", () => {
    store.set(CATALOGUE_KEY, "{not json");
    expect(() => cachedCatalogue()).not.toThrow();
    expect(isUsingFallbackCatalogue()).toBe(true);
  });

  it("drops individual malformed entries and keeps the rest", () => {
    store.set(
      CATALOGUE_KEY,
      JSON.stringify({
        fetchedAt: new Date().toISOString(),
        origin: BACKEND,
        materials: [material({ code: "PET" }), { code: 42 }, { name: "no code" }],
      }),
    );

    expect(cachedCatalogue().map((m) => m.code)).toEqual(["PET"]);
  });

  /**
   * An operator could retire everything. Rendering an empty picker would strand
   * the collector; the server can at least explain a rejection.
   */
  it("falls back rather than render an empty picker when every entry is retired", () => {
    writeCache([material({ code: "PET", active: false })]);

    expect(pickableMaterials().length).toBeGreaterThan(0);
  });
});

describe("refreshCatalogue", () => {
  it("stores what the backend returns and reports the change", async () => {
    respondWith([material({ code: "PVC", name: "Pipe and profile" })]);

    await expect(refreshCatalogue()).resolves.toBe(true);
    expect(cachedCatalogue().map((m) => m.code)).toEqual(["PVC"]);
  });

  it("reports no change when the catalogue is identical, so the UI need not re-render", async () => {
    const catalogue = [material({ code: "PVC" })];
    respondWith(catalogue);

    await refreshCatalogue();
    await expect(refreshCatalogue()).resolves.toBe(false);
  });

  it("detects a rename as a change", async () => {
    respondWith([material({ code: "PVC", name: "Pipe" })]);
    await refreshCatalogue();

    respondWith([material({ code: "PVC", name: "Pipe and profile" })]);
    await expect(refreshCatalogue()).resolves.toBe(true);
    expect(cachedCatalogue()[0].name).toBe("Pipe and profile");
  });

  it("keeps the cached list when the request fails", async () => {
    writeCache([material({ code: "PVC" })]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    await expect(refreshCatalogue()).resolves.toBe(false);
    expect(cachedCatalogue().map((m) => m.code)).toEqual(["PVC"]);
  });

  it("keeps the cached list on a non-2xx response", async () => {
    writeCache([material({ code: "PVC" })]);
    respondWith([], false);

    await expect(refreshCatalogue()).resolves.toBe(false);
    expect(cachedCatalogue().map((m) => m.code)).toEqual(["PVC"]);
  });

  /**
   * An empty catalogue means an unmigrated server, not an instruction to blank
   * the picker.
   */
  it("refuses to blank the picker on an empty response", async () => {
    writeCache([material({ code: "PVC" })]);
    respondWith([]);

    await expect(refreshCatalogue()).resolves.toBe(false);
    expect(cachedCatalogue().map((m) => m.code)).toEqual(["PVC"]);
  });

  it("ignores a response that is not an array", async () => {
    writeCache([material({ code: "PVC" })]);
    respondWith({ message: "unauthorised" });

    await expect(refreshCatalogue()).resolves.toBe(false);
    expect(cachedCatalogue().map((m) => m.code)).toEqual(["PVC"]);
  });

  it("never throws, whatever the network does", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => JSON.parse("{bad") }) as never),
    );

    await expect(refreshCatalogue()).resolves.toBe(false);
  });
});
