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

export type QueueStatus = "queued" | "syncing" | "synced" | "rejected";

export interface QueuedWeighIn {
  id: string;
  payload: WeighInPayload;
  signature: string;
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
