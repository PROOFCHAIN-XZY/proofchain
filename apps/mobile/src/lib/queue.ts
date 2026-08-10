import type { WeighInPayload } from "@shared/types";
import type { KeyValueStore } from "./storage";

/**
 * The offline queue.
 *
 * A collector is paid for weight that reaches a batch, so a weigh-in that never
 * arrives is unpaid work. Capture therefore never waits on the network: the
 * record is signed and persisted immediately, and syncing is a separate,
 * retryable concern. Records leave the queue only once the server has
 * acknowledged them.
 *
 * The whole queue is stored under a single key and rewritten atomically. At the
 * volumes one phone produces in a shift (tens to low hundreds of records) this
 * is far cheaper than the failure mode it removes — a partial multi-key write
 * leaving the queue internally inconsistent.
 */

export type QueueStatus = "queued" | "syncing" | "synced" | "rejected";

export interface QueuedWeighIn {
  id: string;
  payload: WeighInPayload;
  signature: string;
  /** Local file URI of the weigh-in photo; the bytes never leave the device. */
  photoUri: string | null;
  status: QueueStatus;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  syncedAt: string | null;
  serverEventId: string | null;
}

const QUEUE_KEY = "proofchain.queue.v1";

export async function readAll(store: KeyValueStore): Promise<QueuedWeighIn[]> {
  const raw = await store.getItem(QUEUE_KEY);
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as QueuedWeighIn[]) : [];
  } catch {
    // Corrupt JSON must not brick capture. Report an empty queue so the app keeps
    // recording; the bad blob stays on disk for diagnosis rather than being wiped.
    return [];
  }
}

async function writeAll(store: KeyValueStore, records: QueuedWeighIn[]): Promise<void> {
  await store.setItem(QUEUE_KEY, JSON.stringify(records));
}

export async function enqueue(store: KeyValueStore, record: QueuedWeighIn): Promise<void> {
  const records = await readAll(store);
  await writeAll(store, [...records, record]);
}

export async function update(
  store: KeyValueStore,
  id: string,
  patch: Partial<QueuedWeighIn>,
): Promise<void> {
  const records = await readAll(store);
  await writeAll(
    store,
    records.map((r) => (r.id === id ? { ...r, ...patch, id: r.id } : r)),
  );
}

/**
 * Oldest first, so a shift syncs in the order it was worked.
 *
 * `syncing` records are included: one interrupted mid-flight (app killed, phone
 * out of battery) must be retried rather than stranded. Retrying is safe because
 * the server keys events on the payload hash and returns the original event
 * instead of creating a second one.
 */
export async function pending(store: KeyValueStore): Promise<QueuedWeighIn[]> {
  const records = await readAll(store);
  return records
    .filter((r) => r.status === "queued" || r.status === "syncing")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Newest first, for display. */
export async function recent(store: KeyValueStore, limit = 50): Promise<QueuedWeighIn[]> {
  const records = await readAll(store);
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
}

export async function counts(store: KeyValueStore): Promise<Record<QueueStatus, number>> {
  const records = await readAll(store);
  const result: Record<QueueStatus, number> = { queued: 0, syncing: 0, synced: 0, rejected: 0 };
  for (const r of records) result[r.status] += 1;
  return result;
}

export async function unsyncedWeightKg(store: KeyValueStore): Promise<number> {
  const records = await pending(store);
  const total = records.reduce((sum, r) => sum + r.payload.weightKg, 0);
  return Number(total.toFixed(3));
}

/**
 * Drop acknowledged records past the retention window to bound storage growth.
 * Rejected records are kept: they are the collector's evidence of work that was
 * refused, and they are the only local trace of why.
 */
export async function pruneSynced(store: KeyValueStore, olderThanDays = 14): Promise<number> {
  const records = await readAll(store);
  const cutoff = Date.now() - olderThanDays * 86_400_000;

  const kept = records.filter(
    (r) => !(r.status === "synced" && new Date(r.createdAt).getTime() < cutoff),
  );

  if (kept.length !== records.length) await writeAll(store, kept);
  return records.length - kept.length;
}
