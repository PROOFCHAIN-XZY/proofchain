import { openDB, type IDBPDatabase } from "idb";
import type { WeighInPayload } from "@shared/types";

/**
 * The offline queue.
 *
 * Connectivity at a dumpsite is unreliable, so capture must never depend on it.
 * A weigh-in is signed and written to IndexedDB the instant it is taken; sync is
 * a separate, retryable concern. This is the part of the system most likely to
 * lose real revenue if it is wrong — a dropped weigh-in is a tonne nobody gets
 * paid for — so records are only ever removed after the server acknowledges them.
 */

/**
 * `awaiting-gps` is a record the collector has committed to but that has no
 * coordinates yet.
 *
 * A fix can take a minute under a tin roof, and a sack does not wait. The weight,
 * the material and the photo are all perishable — the sack gets tipped, the truck
 * leaves — while the position is not: the collector is standing at the hub either
 * way. So the capture is banked immediately and the position is attached when the
 * GPS answers. It is deliberately not signed until then, because the signature
 * covers the coordinates; signing something and amending it afterwards is the one
 * thing this queue must never do.
 */
export type QueueStatus = "awaiting-gps" | "queued" | "syncing" | "synced" | "rejected";

/** A weigh-in before it has a position: everything except `lat` and `lng`. */
export type UnlocatedPayload = Omit<WeighInPayload, "lat" | "lng">;

export interface QueuedWeighIn {
  id: string;
  /**
   * Typed as possibly-unlocated so that nothing downstream can read `lat` off a
   * draft and get `undefined` at runtime. `isLocated` below is the only way to
   * widen it back to a full, signable `WeighInPayload`.
   */
  payload: UnlocatedPayload & Partial<Pick<WeighInPayload, "lat" | "lng">>;
  /** null while `awaiting-gps`: there is no complete payload to sign yet. */
  signature: string | null;
  photo: Blob | null;
  status: QueueStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  syncedAt: string | null;
  serverEventId: string | null;
  /**
   * When the photo bytes were accepted by the server, or null if they have
   * not been. Tracked separately from syncedAt because the two succeed
   * independently: a weigh-in can be safely recorded while its photo is still
   * waiting for enough bandwidth to send.
   */
  photoUploadedAt: string | null;
}

const DB_NAME = "proofchain-capture";
const DB_VERSION = 1;
const STORE = "weighins";

let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, DB_VERSION, {
    upgrade(database) {
      const store = database.createObjectStore(STORE, { keyPath: "id" });
      store.createIndex("status", "status");
      store.createIndex("createdAt", "createdAt");
    },
  });
  return dbPromise;
}

export async function enqueue(record: QueuedWeighIn): Promise<void> {
  const database = await db();
  await database.put(STORE, record);
}

export async function all(): Promise<QueuedWeighIn[]> {
  const database = await db();
  const records = (await database.getAll(STORE)) as QueuedWeighIn[];
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function pending(): Promise<QueuedWeighIn[]> {
  const records = await all();
  // "syncing" is included: a record stuck mid-flight when the tab closed must be
  // retried, not stranded. The server's payloadHash uniqueness makes retry safe.
  return records
    .filter((r) => r.status === "queued" || r.status === "syncing")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** A record with coordinates and a signature — the only kind that may be sent. */
export type LocatedWeighIn = QueuedWeighIn & { payload: WeighInPayload; signature: string };

/**
 * The gate between a draft and a sendable record.
 *
 * `pending()` already excludes `awaiting-gps`, so an unlocated draft cannot reach
 * the network by that route. This exists so the sync path proves it for itself
 * rather than trusting a status string, and so TypeScript refuses to hand an
 * unsigned payload to anything that posts.
 */
export function isLocated(record: QueuedWeighIn): record is LocatedWeighIn {
  return (
    typeof record.payload.lat === "number" &&
    typeof record.payload.lng === "number" &&
    record.signature !== null
  );
}

/** Drafts waiting for a position, oldest first — the order they should be filled. */
export async function awaitingGps(): Promise<QueuedWeighIn[]> {
  const records = await all();
  return records
    .filter((r) => r.status === "awaiting-gps")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * How long after a capture a fix may still be claimed as its position.
 *
 * This is the honesty bound on the whole deferred-fix idea. A position taken two
 * minutes later is the same place; one taken four hours later is a different
 * claim entirely, and attaching it would be manufacturing evidence for a weigh-in
 * nobody can now locate. Thirty minutes is chosen to comfortably cover a slow
 * fix under a roof while staying well inside one stop on a route.
 */
export const FIX_ATTACH_WINDOW_MS = 30 * 60_000;

export type AttachOutcome =
  | { outcome: "located"; record: LocatedWeighIn }
  /** Captured too long ago for this fix to honestly describe where it happened. */
  | { outcome: "expired"; ageMs: number }
  | { outcome: "missing" };

/**
 * Attach a position to a draft and sign it, in one atomic step.
 *
 * Signing is passed in rather than imported so this module stays free of key
 * material. The write happens only after `sign` returns: if signing throws, the
 * record is left exactly as it was — still a draft, still retryable — instead of
 * being promoted to `queued` with no valid signature, which would sync and be
 * rejected by the server for something the collector cannot see or fix.
 *
 * The window is enforced here, at the only place that can promote a draft, so no
 * caller can route around it.
 */
export async function attachFix(
  id: string,
  position: { lat: number; lng: number; at: string },
  sign: (payload: WeighInPayload) => string,
): Promise<AttachOutcome> {
  const database = await db();
  const existing = (await database.get(STORE, id)) as QueuedWeighIn | undefined;
  if (!existing || existing.status !== "awaiting-gps") return { outcome: "missing" };

  const ageMs =
    new Date(position.at).getTime() - new Date(existing.payload.capturedAt).getTime();
  if (!Number.isFinite(ageMs) || ageMs > FIX_ATTACH_WINDOW_MS) {
    await database.put(STORE, {
      ...existing,
      lastError:
        "no GPS fix was taken within 30 minutes of this weigh-in, so it cannot be located or sent",
    });
    return { outcome: "expired", ageMs };
  }

  const payload: WeighInPayload = { ...existing.payload, lat: position.lat, lng: position.lng };
  const located: LocatedWeighIn = {
    ...existing,
    payload,
    signature: sign(payload),
    status: "queued",
    lastError: null,
  };

  await database.put(STORE, located);
  return { outcome: "located", record: located };
}

/**
 * Records whose weigh-in landed but whose photo did not.
 *
 * Without this the photo is stranded: `pending()` deliberately excludes synced
 * records, so a photo that failed its upload once would sit on the phone until
 * the retention window deleted it.
 */
export async function pendingPhotos(): Promise<QueuedWeighIn[]> {
  const records = await all();
  return records
    .filter(
      (r) =>
        r.status === "synced" &&
        r.serverEventId !== null &&
        r.photo !== null &&
        r.photoUploadedAt === null,
    )
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function update(id: string, patch: Partial<QueuedWeighIn>): Promise<void> {
  const database = await db();
  const existing = (await database.get(STORE, id)) as QueuedWeighIn | undefined;
  if (!existing) return;
  await database.put(STORE, { ...existing, ...patch });
}

export async function counts(): Promise<Record<QueueStatus, number>> {
  const records = await all();
  const result: Record<QueueStatus, number> = {
    "awaiting-gps": 0,
    queued: 0,
    syncing: 0,
    synced: 0,
    rejected: 0,
  };
  for (const r of records) result[r.status] += 1;
  return result;
}

/** Drop synced records older than the retention window to bound storage growth. */
export async function pruneSynced(olderThanDays = 14): Promise<number> {
  const database = await db();
  const cutoff = Date.now() - olderThanDays * 86_400_000;
  const records = (await database.getAll(STORE)) as QueuedWeighIn[];

  let removed = 0;
  for (const r of records) {
    // A record whose photo has not been handed over yet is not finished, however
    // old it is: deleting it destroys the only copy of that evidence.
    const photoOutstanding = r.photo !== null && r.photoUploadedAt === null;
    if (r.status === "synced" && !photoOutstanding && new Date(r.createdAt).getTime() < cutoff) {
      await database.delete(STORE, r.id);
      removed += 1;
    }
  }
  return removed;
}
