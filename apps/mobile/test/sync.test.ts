import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WeighInPayload } from "@shared/types";
import * as queue from "../src/lib/queue";
import { getBackendUrl, setBackendUrl, syncPending, type IngestResponse } from "../src/lib/api";
import { createMemoryStore, type KeyValueStore } from "../src/lib/storage";

function payload(weightKg = 10): WeighInPayload {
  return {
    schema: "proofchain.weighin.v2",
    collectorId: "c1",
    hubId: "h1",
    deviceId: "d1",
    weightKg,
    material: "PET",
    capturedAt: "2026-08-08T10:00:00.000Z",
    photoHash: "a".repeat(64),
    nonce: "b".repeat(32),
  };
}

function record(over: Partial<queue.QueuedWeighIn> = {}): queue.QueuedWeighIn {
  return {
    id: "r1",
    payload: payload(),
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

function accepted(over: Partial<IngestResponse> = {}): IngestResponse {
  return {
    eventId: "e1",
    payloadHash: "c".repeat(64),
    quarantined: false,
    duplicate: false,
    integrity: { outcome: "pass", findings: [] },
    ...over,
  };
}

const online = { isOnline: async () => true };
const offline = { isOnline: async () => false };

let store: KeyValueStore;

beforeEach(() => {
  store = createMemoryStore();
});

describe("backend url", () => {
  it("defaults to the emulator's host loopback", async () => {
    expect(await getBackendUrl(store)).toBe("http://10.0.2.2:3000");
  });

  it("strips trailing slashes so paths do not double up", async () => {
    await setBackendUrl(store, "  https://api.example.org///  ");

    expect(await getBackendUrl(store)).toBe("https://api.example.org");
  });
});

describe("syncPending", () => {
  it("does nothing when the phone is offline", async () => {
    await queue.enqueue(store, record());
    const post = vi.fn();

    const outcome = await syncPending(store, { ...offline, post });

    expect(post).not.toHaveBeenCalled();
    expect(outcome.attempted).toBe(0);
    expect((await queue.readAll(store))[0]?.status).toBe("queued");
  });

  it("marks an accepted weigh-in synced and records the server event id", async () => {
    await queue.enqueue(store, record());

    const outcome = await syncPending(store, { ...online, post: async () => accepted() });

    expect(outcome).toMatchObject({ attempted: 1, synced: 1, rejected: 0, failed: 0 });
    const stored = (await queue.readAll(store))[0];
    expect(stored?.status).toBe("synced");
    expect(stored?.serverEventId).toBe("e1");
    expect(stored?.syncedAt).not.toBeNull();
  });

  it("keeps a record queued and counts the attempt when the network fails", async () => {
    await queue.enqueue(store, record());

    const outcome = await syncPending(store, {
      ...online,
      post: async () => {
        throw new Error("network down");
      },
    });

    expect(outcome).toMatchObject({ failed: 1, synced: 0 });
    const stored = (await queue.readAll(store))[0];
    // Requeued, never dropped — this is a collector's unpaid work.
    expect(stored?.status).toBe("queued");
    expect(stored?.attempts).toBe(1);
    expect(stored?.lastError).toBe("network down");
  });

  it("retries a record left mid-flight by an earlier crash", async () => {
    await queue.enqueue(store, record({ status: "syncing", attempts: 1 }));

    const outcome = await syncPending(store, { ...online, post: async () => accepted() });

    expect(outcome.synced).toBe(1);
  });

  it("marks a quarantined weigh-in rejected with the reasons it failed", async () => {
    await queue.enqueue(store, record());

    const outcome = await syncPending(store, {
      ...online,
      post: async () =>
        accepted({
          quarantined: true,
          integrity: {
            outcome: "fail",
            findings: [
              { check: "weight_in_range", outcome: "fail", detail: "5000 kg above hub maximum" },
              { check: "weight_in_range", outcome: "pass" },
            ],
          },
        }),
    });

    expect(outcome.rejected).toBe(1);
    const stored = (await queue.readAll(store))[0];
    expect(stored?.status).toBe("rejected");
    // The collector needs a reason they can act on, not the name of a check:
    // this string is rendered on the phone of the person who could still
    // re-weigh the material. The raw finding stays on the server's event.
    expect(stored?.lastError).toBe(
      "The weight is outside what this hub accepts. Re-weigh the material and capture it again.",
    );
  });

  it("treats a quarantined duplicate as already settled, not a fresh rejection", async () => {
    await queue.enqueue(store, record());

    const outcome = await syncPending(store, {
      ...online,
      post: async () => accepted({ quarantined: true, duplicate: true }),
    });

    expect(outcome).toMatchObject({ synced: 1, rejected: 0 });
    expect((await queue.readAll(store))[0]?.status).toBe("synced");
  });

  it("syncs a full shift in captured order and leaves nothing pending", async () => {
    for (let i = 0; i < 5; i++) {
      await queue.enqueue(
        store,
        record({ id: `r${i}`, createdAt: `2026-08-08T1${i}:00:00.000Z` }),
      );
    }

    const seen: string[] = [];
    const outcome = await syncPending(store, {
      ...online,
      post: async (_url, r) => {
        seen.push(r.id);
        return accepted({ eventId: `e-${r.id}` });
      },
    });

    expect(outcome.synced).toBe(5);
    expect(seen).toEqual(["r0", "r1", "r2", "r3", "r4"]);
    expect(await queue.pending(store)).toEqual([]);
  });

  it("keeps syncing the rest of the shift after one record fails", async () => {
    await queue.enqueue(store, record({ id: "r1", createdAt: "2026-08-08T10:00:00.000Z" }));
    await queue.enqueue(store, record({ id: "r2", createdAt: "2026-08-08T11:00:00.000Z" }));

    const outcome = await syncPending(store, {
      ...online,
      post: async (_url, r) => {
        if (r.id === "r1") throw new Error("timeout");
        return accepted();
      },
    });

    expect(outcome).toMatchObject({ attempted: 2, synced: 1, failed: 1 });
    expect((await queue.pending(store)).map((r) => r.id)).toEqual(["r1"]);
  });

  it("posts to the configured backend", async () => {
    await setBackendUrl(store, "https://api.example.org");
    await queue.enqueue(store, record());
    const urls: string[] = [];

    await syncPending(store, {
      ...online,
      post: async (url) => {
        urls.push(url);
        return accepted();
      },
    });

    expect(urls).toEqual(["https://api.example.org"]);
  });
});

describe("syncPending — photo upload", () => {
  const online = { isOnline: async () => true };

  it("sends the photo to the event id the server assigned", async () => {
    const store = createMemoryStore();
    await queue.enqueue(store, record({ photoUri: "file:///weighin.jpg" }));
    const sent: { eventId: string; photoUri: string }[] = [];

    const outcome = await syncPending(store, {
      ...online,
      post: async () => accepted({ eventId: "e-42" }),
      sendPhoto: async (_url, eventId, photoUri) => {
        sent.push({ eventId, photoUri });
      },
    });

    expect(sent).toEqual([{ eventId: "e-42", photoUri: "file:///weighin.jpg" }]);
    expect(outcome.photosUploaded).toBe(1);
    expect((await queue.readAll(store))[0]!.photoUploadedAt).toEqual(expect.any(String));
  });

  it("keeps the weigh-in synced when the photo fails", async () => {
    const store = createMemoryStore();
    await queue.enqueue(store, record({ photoUri: "file:///weighin.jpg" }));

    const outcome = await syncPending(store, {
      ...online,
      post: async () => accepted(),
      sendPhoto: async () => {
        throw new Error("connection reset");
      },
    });

    // The tonne is recorded either way. A missing photo is weaker evidence,
    // not unpaid work.
    expect(outcome.synced).toBe(1);
    expect(outcome.photosUploaded).toBe(0);

    const stored = (await queue.readAll(store))[0]!;
    expect(stored.status).toBe("synced");
    expect(stored.photoUploadedAt).toBeNull();
  });

  it("retries a photo whose weigh-in synced on an earlier pass", async () => {
    const store = createMemoryStore();
    await queue.enqueue(
      store,
      record({
        status: "synced",
        serverEventId: "e-9",
        syncedAt: "2026-08-08T11:00:00.000Z",
        photoUri: "file:///weighin.jpg",
      }),
    );
    const sent: string[] = [];

    const outcome = await syncPending(store, {
      ...online,
      post: async () => {
        throw new Error("pending() must not pick this record up");
      },
      sendPhoto: async (_url, eventId) => {
        sent.push(eventId);
      },
    });

    expect(sent).toEqual(["e-9"]);
    expect(outcome.photosUploaded).toBe(1);
    expect(outcome.attempted).toBe(0);
  });

  it("stops retrying once the photo has been accepted", async () => {
    const store = createMemoryStore();
    await queue.enqueue(
      store,
      record({
        status: "synced",
        serverEventId: "e-9",
        photoUri: "file:///weighin.jpg",
        photoUploadedAt: "2026-08-08T11:05:00.000Z",
      }),
    );

    const outcome = await syncPending(store, {
      ...online,
      post: async () => accepted(),
      sendPhoto: async () => {
        throw new Error("must not re-upload an accepted photo");
      },
    });

    expect(outcome.photosUploaded).toBe(0);
  });

  it("keeps a record with an outstanding photo past the retention window", async () => {
    const store = createMemoryStore();
    await queue.enqueue(
      store,
      record({
        status: "synced",
        serverEventId: "e-9",
        createdAt: "2020-01-01T00:00:00.000Z",
        photoUri: "file:///weighin.jpg",
      }),
    );

    // Pruning it would discard the only reference to the photo, and a phone
    // can easily sit unused for longer than the window between shifts.
    expect(await queue.pruneSynced(store)).toBe(0);
    expect(await queue.readAll(store)).toHaveLength(1);
  });
});
