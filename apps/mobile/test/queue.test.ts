import { beforeEach, describe, expect, it } from "vitest";
import type { WeighInPayload } from "@shared/types";
import * as queue from "../src/lib/queue";
import { createMemoryStore, type KeyValueStore } from "../src/lib/storage";

function payload(weightKg: number): WeighInPayload {
  return {
    schema: "proofchain.weighin.v1",
    collectorId: "c1",
    hubId: "h1",
    deviceId: "d1",
    weightKg,
    material: "PET",
    lat: -1.286389,
    lng: 36.817223,
    capturedAt: "2026-08-08T10:00:00.000Z",
    photoHash: "a".repeat(64),
    nonce: "b".repeat(32),
  };
}

function record(over: Partial<queue.QueuedWeighIn> = {}): queue.QueuedWeighIn {
  return {
    id: "r1",
    payload: payload(10),
    signature: "sig",
    photoUri: null,
    status: "queued",
    attempts: 0,
    lastError: null,
    createdAt: "2026-08-08T10:00:00.000Z",
    syncedAt: null,
    serverEventId: null,
    photoUploadedAt: null,
    ...over,
  };
}

let store: KeyValueStore;

beforeEach(() => {
  store = createMemoryStore();
});

describe("queue persistence", () => {
  it("returns an empty queue before anything is captured", async () => {
    expect(await queue.readAll(store)).toEqual([]);
  });

  it("persists an enqueued weigh-in", async () => {
    await queue.enqueue(store, record());

    const all = await queue.readAll(store);
    expect(all).toHaveLength(1);
    expect(all[0]?.payload.weightKg).toBe(10);
  });

  it("keeps every record when several are captured", async () => {
    await queue.enqueue(store, record({ id: "r1" }));
    await queue.enqueue(store, record({ id: "r2" }));
    await queue.enqueue(store, record({ id: "r3" }));

    expect(await queue.readAll(store)).toHaveLength(3);
  });

  it("reports an empty queue rather than throwing when storage is corrupt", async () => {
    await store.setItem("proofchain.queue.v1", "{not json");

    // Capture must keep working; the unreadable blob is left on disk for
    // diagnosis rather than silently wiped.
    expect(await queue.readAll(store)).toEqual([]);
  });

  it("survives a stored value that is valid JSON but not an array", async () => {
    await store.setItem("proofchain.queue.v1", '{"oops":true}');

    expect(await queue.readAll(store)).toEqual([]);
  });
});

describe("update", () => {
  it("patches only the addressed record", async () => {
    await queue.enqueue(store, record({ id: "r1" }));
    await queue.enqueue(store, record({ id: "r2" }));

    await queue.update(store, "r1", { status: "synced", serverEventId: "e1" });

    const all = await queue.readAll(store);
    expect(all.find((r) => r.id === "r1")?.status).toBe("synced");
    expect(all.find((r) => r.id === "r2")?.status).toBe("queued");
  });

  it("refuses to let a patch rewrite the record id", async () => {
    await queue.enqueue(store, record({ id: "r1" }));

    await queue.update(store, "r1", { id: "hijacked" } as Partial<queue.QueuedWeighIn>);

    expect((await queue.readAll(store))[0]?.id).toBe("r1");
  });

  it("is a no-op for an unknown id", async () => {
    await queue.enqueue(store, record({ id: "r1" }));

    await queue.update(store, "missing", { status: "synced" });

    expect((await queue.readAll(store))[0]?.status).toBe("queued");
  });
});

describe("pending", () => {
  it("includes records interrupted mid-sync so they are never stranded", async () => {
    await queue.enqueue(store, record({ id: "r1", status: "syncing" }));

    expect((await queue.pending(store)).map((r) => r.id)).toEqual(["r1"]);
  });

  it("excludes records the server has already settled", async () => {
    await queue.enqueue(store, record({ id: "r1", status: "synced" }));
    await queue.enqueue(store, record({ id: "r2", status: "rejected" }));

    expect(await queue.pending(store)).toEqual([]);
  });

  it("syncs oldest first, in the order the shift was worked", async () => {
    await queue.enqueue(store, record({ id: "new", createdAt: "2026-08-08T12:00:00.000Z" }));
    await queue.enqueue(store, record({ id: "old", createdAt: "2026-08-08T08:00:00.000Z" }));

    expect((await queue.pending(store)).map((r) => r.id)).toEqual(["old", "new"]);
  });
});

describe("counts and unsynced weight", () => {
  it("counts records by status", async () => {
    await queue.enqueue(store, record({ id: "r1", status: "queued" }));
    await queue.enqueue(store, record({ id: "r2", status: "synced" }));
    await queue.enqueue(store, record({ id: "r3", status: "rejected" }));

    expect(await queue.counts(store)).toEqual({ queued: 1, syncing: 0, synced: 1, rejected: 1 });
  });

  it("totals only the weight still owed to the collector", async () => {
    await queue.enqueue(store, record({ id: "r1", payload: payload(12.5) }));
    await queue.enqueue(store, record({ id: "r2", payload: payload(7.25) }));
    await queue.enqueue(store, record({ id: "r3", status: "synced", payload: payload(100) }));

    expect(await queue.unsyncedWeightKg(store)).toBe(19.75);
  });

  it("does not accumulate float noise across many records", async () => {
    for (let i = 0; i < 3; i++) {
      await queue.enqueue(store, record({ id: `r${i}`, payload: payload(0.1) }));
    }

    expect(await queue.unsyncedWeightKg(store)).toBe(0.3);
  });
});

describe("pruneSynced", () => {
  const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const fresh = new Date().toISOString();

  it("drops acknowledged records past the retention window", async () => {
    await queue.enqueue(store, record({ id: "r1", status: "synced", createdAt: old }));

    expect(await queue.pruneSynced(store)).toBe(1);
    expect(await queue.readAll(store)).toEqual([]);
  });

  it("keeps acknowledged records inside the window", async () => {
    await queue.enqueue(store, record({ id: "r1", status: "synced", createdAt: fresh }));

    expect(await queue.pruneSynced(store)).toBe(0);
  });

  it("never drops unsynced work, however old", async () => {
    await queue.enqueue(store, record({ id: "r1", status: "queued", createdAt: old }));

    expect(await queue.pruneSynced(store)).toBe(0);
    expect(await queue.readAll(store)).toHaveLength(1);
  });

  it("keeps rejected records as the collector's evidence of refused work", async () => {
    await queue.enqueue(store, record({ id: "r1", status: "rejected", createdAt: old }));

    expect(await queue.pruneSynced(store)).toBe(0);
    expect(await queue.readAll(store)).toHaveLength(1);
  });
});
