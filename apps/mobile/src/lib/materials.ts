import {
  activeMaterials,
  normaliseExamples,
  SEED_MATERIALS,
  sortMaterials,
  type Material,
} from "@shared/materials";
import type { KeyValueStore } from "./storage";

/**
 * The material catalogue on the device — the Expo counterpart to the PWA's
 * `lib/materials.ts`, with the same contract and the same reasoning.
 *
 * Async rather than synchronous because AsyncStorage is, which is the one real
 * difference from the web version: the screen holds the catalogue in state and
 * loads it in an effect, instead of reading it during render.
 *
 * The rules it exists to enforce are the same. An operator can add or retire a
 * material at any time, so nothing may be hardcoded. A collector at a scale
 * usually has no signal, so the last known list must render immediately. A phone
 * that has never reached this backend must still work, so `SEED_MATERIALS` is the
 * floor.
 */

const CACHE_KEY = "proofchain.materials.v1";

interface CachedCatalogue {
  fetchedAt: string;
  /** The backend this came from; a different one invalidates the cache. */
  origin: string;
  materials: Material[];
}

export interface Catalogue {
  /** Everything, retired included — needed to label queued and synced records. */
  all: Material[];
  /** What a collector may pick right now. Never empty. */
  pickable: [Material, ...Material[]];
  /** True when this is the compiled-in fallback rather than a fetched list. */
  isFallback: boolean;
  fetchedAt: string | null;
}

/**
 * The catalogue before storage or the network has been consulted — what the
 * picker renders on its very first frame.
 *
 * Lives here rather than in the screen so the non-empty guarantee is established
 * in exactly one place.
 */
export function fallbackCatalogue(): Catalogue {
  return {
    all: sortMaterials(SEED_MATERIALS),
    pickable: pickableFrom(SEED_MATERIALS),
    isFallback: true,
    fetchedAt: null,
  };
}

/** The catalogue as it stands locally, without touching the network. */
export async function loadCatalogue(
  store: KeyValueStore,
  origin: string,
): Promise<Catalogue> {
  const cached = await readCache(store, origin);
  const all = sortMaterials(cached?.materials ?? SEED_MATERIALS);
  return {
    all,
    pickable: pickableFrom(all),
    isFallback: cached === null,
    fetchedAt: cached?.fetchedAt ?? null,
  };
}

/**
 * Fetch and cache. Never throws.
 *
 * Returns the catalogue to use either way, so a caller can assign the result
 * unconditionally — a failed refresh yields the cached list, which is exactly
 * what should stay on screen.
 */
export async function refreshCatalogue(
  store: KeyValueStore,
  origin: string,
): Promise<Catalogue> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    const res = await fetch(`${origin}/materials`, { signal: controller.signal });
    if (!res.ok) return loadCatalogue(store, origin);

    const body: unknown = await res.json();
    if (!Array.isArray(body)) return loadCatalogue(store, origin);

    const clean = body.filter((m: unknown) => isMaterial(m)).map(sanitise);
    // An empty catalogue is an unmigrated server, not an instruction to blank the
    // picker. Keep whatever is cached.
    if (clean.length === 0) return loadCatalogue(store, origin);

    await store.setItem(
      CACHE_KEY,
      JSON.stringify({
        fetchedAt: new Date().toISOString(),
        origin,
        materials: clean,
      } satisfies CachedCatalogue),
    );

    return loadCatalogue(store, origin);
  } catch {
    return loadCatalogue(store, origin);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The code to select, given a catalogue and whatever was selected before.
 *
 * Keeps the current choice when it is still offered and falls back to the first
 * available code when it is not — an operator can retire a material while the app
 * sits open on the capture screen, and leaving a retired code selected would have
 * the collector sign weigh-ins that can never be batched.
 */
export function reconcileSelection(catalogue: Catalogue, current: string | null): string {
  if (current && catalogue.pickable.some((m) => m.code === current)) return current;
  return catalogue.pickable[0].code;
}

function pickableFrom(all: readonly Material[]): [Material, ...Material[]] {
  const active = activeMaterials(all);
  if (isNonEmpty(active)) return active;

  const seeded = activeMaterials(SEED_MATERIALS);
  if (isNonEmpty(seeded)) return seeded;

  return [
    {
      code: "MIXED",
      name: "Mixed plastic",
      description: null,
      examples: [],
      active: true,
      sortOrder: 0,
    },
  ];
}

function isNonEmpty(materials: Material[]): materials is [Material, ...Material[]] {
  return materials.length > 0;
}

async function readCache(
  store: KeyValueStore,
  origin: string,
): Promise<CachedCatalogue | null> {
  const raw = await store.getItem(CACHE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as CachedCatalogue;
    if (!Array.isArray(parsed.materials)) return null;
    // A code valid on one instance may not exist on another, and signing against
    // a stale list produces a weigh-in the new server rejects outright.
    if (parsed.origin !== origin) return null;

    const materials = parsed.materials.filter((m: unknown) => isMaterial(m)).map(sanitise);
    return materials.length > 0 ? { ...parsed, materials } : null;
  } catch {
    return null;
  }
}

/**
 * Force the optional-looking parts of a wire or cache entry into the shape the
 * screen assumes.
 *
 * `examples` is why: a cache written before the field shipped carries none, and
 * so does a backend that predates it. Both are ordinary mid-rollout, and neither
 * may reach the picker as `undefined` — this is the one screen a collector
 * cannot work around.
 */
function sanitise(material: Material): Material {
  return { ...material, examples: normaliseExamples(material.examples) };
}

/** Trust nothing from storage or the wire; one bad entry must not break the picker. */
function isMaterial(value: unknown): value is Material {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Partial<Material>;
  return (
    typeof m.code === "string" &&
    m.code.length > 0 &&
    typeof m.name === "string" &&
    typeof m.active === "boolean"
  );
}
