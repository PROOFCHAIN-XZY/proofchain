import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueuedWeighIn } from "../src/lib/queue";

/**
 * Photo upload is the one part of sync that is allowed to fail without
 * consequence. These tests pin that boundary: a photo that cannot be sent must
 * never cost a weigh-in, and must never be forgotten either.
 */

const queue = vi.hoisted(() => ({
  pending: vi.fn(),
  pendingPhotos: vi.fn(),
  update: vi.fn(),
  // The real guard, not a stub: these fixtures are all located records, and a
  // mock that waved everything through would hide a sync path that had stopped
  // checking. The one implementation detail it must mirror is that a record is
  // sendable only with coordinates and a signature.
  isLocated: (r: QueuedWeighIn) =>
    typeof r.payload.lat === "number" &&
    typeof r.payload.lng === "number" &&
    r.signature !== null,
}));

vi.mock("../src/lib/queue", () => queue);

const { syncPending } = await import("../src/lib/api");

const PHOTO = new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], { type: "image/jpeg" });

function record(overrides: Partial<QueuedWeighIn> = {}): QueuedWeighIn {
  return {
    id: "queued-1",
    payload: {
      schema: "proofchain.weighin.v2",
      lat: 6.5244,
      lng: 3.3792,
    } as QueuedWeighIn["payload"],
    signature: "sig",
    photo: PHOTO,
    status: "queued",
    attempts: 0,
    lastError: null,
    createdAt: "2026-03-01T08:00:00.000Z",
    syncedAt: null,
    serverEventId: null,
    photoUploadedAt: null,
    ...overrides,
  };
}

const accepted = {
  eventId: "event-1",
  payloadHash: "a".repeat(64),
  quarantined: false,
  duplicate: false,
  integrity: { outcome: "pass" as const, findings: [] },
};

/** Answers the weigh-in POST from `ok`, and the photo POST from `photoOk`. */
function stubFetch(options: { photoOk: boolean }) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push(String(url));
      if (String(url).endsWith("/photo")) {
        return options.photoOk
          ? new Response("{}", { status: 200 })
          : new Response("upstream down", { status: 502 });
      }
      return new Response(JSON.stringify(accepted), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.stubGlobal("navigator", { onLine: true });
  // backendUrl() reads localStorage, which does not exist under the node
  // environment this suite runs in.
  vi.stubGlobal("localStorage", {
    getItem: () => "https://backend.test",
    setItem: () => undefined,
  });
  queue.pending.mockResolvedValue([]);
  queue.pendingPhotos.mockResolvedValue([]);
});

describe("syncPending — photo upload", () => {
  it("sends the photo to the event id the server assigned", async () => {
    queue.pending.mockResolvedValue([record()]);
    const calls = stubFetch({ photoOk: true });

    const outcome = await syncPending();

    expect(calls.at(-1)).toMatch(/\/events\/event-1\/photo$/);
    expect(outcome.synced).toBe(1);
    expect(outcome.photosUploaded).toBe(1);
    expect(queue.update).toHaveBeenLastCalledWith(
      "queued-1",
      expect.objectContaining({ status: "synced", photoUploadedAt: expect.any(String) }),
    );
  });

  it("keeps the weigh-in synced when the photo upload fails", async () => {
    queue.pending.mockResolvedValue([record()]);
    stubFetch({ photoOk: false });

    const outcome = await syncPending();

    // The tonne is recorded. A missing photo is weaker evidence, not lost work,
    // and rolling the weigh-in back would turn a slow link into unpaid labour.
    expect(outcome.synced).toBe(1);
    expect(outcome.photosUploaded).toBe(0);
    expect(queue.update).toHaveBeenLastCalledWith(
      "queued-1",
      expect.objectContaining({ status: "synced", photoUploadedAt: null }),
    );
  });

  it("retries a photo whose weigh-in synced on an earlier pass", async () => {
    queue.pendingPhotos.mockResolvedValue([
      record({ status: "synced", serverEventId: "event-9", syncedAt: "2026-03-01T09:00:00.000Z" }),
    ]);
    const calls = stubFetch({ photoOk: true });

    const outcome = await syncPending();

    // Invisible to pending(); without the second pass these bytes are stranded.
    expect(calls).toEqual([expect.stringMatching(/\/events\/event-9\/photo$/)]);
    expect(outcome.photosUploaded).toBe(1);
    expect(queue.update).toHaveBeenCalledWith(
      "queued-1",
      expect.objectContaining({ photoUploadedAt: expect.any(String) }),
    );
  });

  it("leaves the record alone when the retry fails again", async () => {
    queue.pendingPhotos.mockResolvedValue([
      record({ status: "synced", serverEventId: "event-9" }),
    ]);
    stubFetch({ photoOk: false });

    const outcome = await syncPending();

    expect(outcome.photosUploaded).toBe(0);
    // Not marked uploaded, so the next pass tries again.
    expect(queue.update).not.toHaveBeenCalled();
  });

  it("does not attempt an upload for a weigh-in captured without a photo", async () => {
    queue.pending.mockResolvedValue([record({ photo: null })]);
    const calls = stubFetch({ photoOk: true });

    await syncPending();

    expect(calls.some((c) => c.endsWith("/photo"))).toBe(false);
  });
});
