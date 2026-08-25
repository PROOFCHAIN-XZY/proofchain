import {
  activeMaterials,
  normaliseExamples,
  SEED_MATERIALS,
  sortMaterials,
  type Material,
} from "@shared/materials";
import { backendUrl } from "./api";

/**
 * The material catalogue on the device.
 *
 * Three requirements pull in different directions here, and the cache is what
 * reconciles them:
 *
 * 1. An operator can add or retire a material at any time, so the device cannot
 *    ship a fixed list.
 * 2. A collector standing at a scale usually has no signal. The picker must
 *    render immediately, from local state, with no await and no spinner.
 * 3. A phone that has never once reached this backend still has to work.
 *
 * So: render synchronously from cache, refresh in the background when there is a
 * connection, and fall back to the codes compiled into the shared package if
 * there has never been a successful fetch. The catalogue is small, public and
 * changes rarely, which is what makes a plain localStorage copy sufficient — the
 * queue is what needs IndexedDB, not this.
 */

const CACHE_KEY = "proofchain.materials.v1";

interface CachedCatalogue {
  fetchedAt: string;
  /** The backend this list came from; a different one invalidates it. */
  origin: string;
  materials: Material[];
}

/**
 * The catalogue to render right now, without waiting for the network.
 *
 * Returns the full list including retired entries, because the queue view has to
 * label records whose material has since been retired. Call `activeMaterials()`
 * on the result for the picker.
 */
export function cachedCatalogue(): Material[] {
  const cached = readCache();
  if (cached && cached.materials.length > 0) return sortMaterials(cached.materials);
  return sortMaterials(SEED_MATERIALS);
}

/**
 * Just the entries a collector may choose for a new weigh-in.
 *
 * The non-empty return type is load-bearing, not decoration: callers index `[0]`
 * for the default selection, and an empty picker would mean a collector who
 * cannot capture at all. Every fallback below exists to honour that signature.
 */
export function pickableMaterials(): [Material, ...Material[]] {
  const pickable = activeMaterials(cachedCatalogue());
  if (isNonEmpty(pickable)) return pickable;

  // Every entry in the fetched catalogue is retired. Fall back to the seed list
  // rather than render nothing: the server may well reject the choice, but it
  // will say why, whereas an empty picker just leaves the collector stuck at the
  // scale with no way to record the sack in front of them.
  const seeded = activeMaterials(SEED_MATERIALS);
  if (isNonEmpty(seeded)) return seeded;

  // Unreachable unless SEED_MATERIALS itself is emptied or wholly retired, which
  // a shared-package test guards against. Still handled rather than asserted,
  // because the cost of being wrong is a blank screen in the field.
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

/** True when this device has never successfully fetched a catalogue. */
export function isUsingFallbackCatalogue(): boolean {
  return readCache() === null;
}

export function catalogueFetchedAt(): string | null {
  return readCache()?.fetchedAt ?? null;
}

/**
 * Refresh from the backend. Never throws.
 *
 * A failed refresh is not an error the collector can act on — the cached list is
 * still perfectly usable, and the whole app is built to keep working offline. The
 * boolean says whether anything changed, so the caller can skip a re-render.
 */
export async function refreshCatalogue(): Promise<boolean> {
  const origin = backendUrl();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    const res = await fetch(`${origin}/materials`, { signal: controller.signal });
    if (!res.ok) return false;

    const materials = (await res.json()) as Material[];
    // An empty catalogue is a server that has not been migrated, not an
    // instruction to blank the picker. Keep what we have.
    if (!Array.isArray(materials) || materials.length === 0) return false;

    const clean = materials.filter((m: unknown) => isMaterial(m)).map(sanitise);
    if (clean.length === 0) return false;

    const previous = readCache();
    const unchanged =
      previous?.origin === origin && serialise(previous.materials) === serialise(clean);

    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({
        fetchedAt: new Date().toISOString(),
        origin,
        materials: clean,
      } satisfies CachedCatalogue),
    );

    return !unchanged;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function readCache(): CachedCatalogue | null {
  const raw = localStorage.getItem(CACHE_KEY);
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as CachedCatalogue;
    if (!Array.isArray(parsed.materials)) return null;
    // Pointing the app at a different backend must not carry the old catalogue
    // across: a code valid on one instance may not exist on another, and signing
    // against a stale list produces a weigh-in the new server rejects.
    if (parsed.origin !== backendUrl()) return null;
    return { ...parsed, materials: parsed.materials.filter(isMaterial).map(sanitise) };
  } catch {
    return null;
  }
}

/** Trust nothing from storage or the wire; a malformed entry must not break the picker. */
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

/**
 * Force the optional-looking parts of a wire or cache entry into the shape the
 * UI assumes.
 *
 * `examples` is the reason this exists. A cache written before the field shipped
 * has none, and a backend that predates it sends none — both are ordinary during
 * a staged rollout, and neither may reach the picker as `undefined`, because the
 * capture screen is the one screen a collector cannot work around.
 */
function sanitise(material: Material): Material {
  return { ...material, examples: normaliseExamples(material.examples) };
}

function serialise(materials: readonly Material[]): string {
  return sortMaterials(materials)
    .map((m) => `${m.code}|${m.name}|${m.active}|${m.sortOrder}|${m.examples.join(",")}`)
    .join(";");
}
