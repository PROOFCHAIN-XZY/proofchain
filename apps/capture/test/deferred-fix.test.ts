import { beforeEach, describe, expect, it, vi } from "vitest";
// `auto` installs the IDBRequest/IDBDatabase globals that `idb` reaches for;
// the factory is swapped per test below purely for isolation.
import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import type { WeighInPayload } from "@shared/types";
import type { UnlocatedPayload } from "../src/lib/queue";

/**
 * Capturing without a position is allowed; *claiming* a position the collector
 * never measured is not. These tests pin the boundary between the two — the
 * whole deferred-fix design rests on it.
 */

// A brand-new IndexedDB and a brand-new module instance per test. The queue
// memoises its database handle, so swapping the factory alone would leave the
// previous test's store attached.
let queue: typeof import("../src/lib/queue");

const CAPTURED_AT = "2026-03-01T08:00:00.000Z";
const HUB = { lat: 6.5244, lng: 3.3792 };

function unlocated(overrides: Partial<UnlocatedPayload> = {}): UnlocatedPayload {
  return {
    schema: "proofchain.weighin.v1",
    collectorId: "c1",
    hubId: "h1",
    deviceId: "d1",
    weightKg: 12.5,
    material: "PET",
    capturedAt: CAPTURED_AT,
    photoHash: "a".repeat(64),
    nonce: "n1",
    ...overrides,
  } as UnlocatedPayload;
}

async function seedDraft(id: string, capturedAt = CAPTURED_AT): Promise<void> {
  await queue.enqueue({
    id,
    payload: unlocated({ capturedAt }),
    signature: null,
    photo: null,
    status: "awaiting-gps",
    attempts: 0,
    lastError: null,
    createdAt: capturedAt,
    syncedAt: null,
    serverEventId: null,
    photoUploadedAt: null,
  });
}

const signer = (payload: WeighInPayload) => `signed:${payload.lat},${payload.lng}`;
const minutesAfter = (mins: number) =>
  new Date(new Date(CAPTURED_AT).getTime() + mins * 60_000).toISOString();

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  vi.resetModules();
  queue = await import("../src/lib/queue");
});

describe("capturing without a GPS fix", () => {
  it("holds the weigh-in as an unsigned draft", async () => {
    await seedDraft("d-1");

    const [held] = await queue.awaitingGps();
    expect(held?.status).toBe("awaiting-gps");
    // Unsigned on purpose: the signature covers the coordinates, so there is
    // nothing honest to sign until one exists.
    expect(held?.signature).toBeNull();
    expect(held?.payload.weightKg).toBe(12.5);
  });

  it("keeps a draft out of the sync queue", async () => {
    await seedDraft("d-1");
    expect(await queue.pending()).toHaveLength(0);
  });

  it("refuses to treat a draft as sendable", async () => {
    await seedDraft("d-1");
    const [held] = await queue.awaitingGps();
    expect(queue.isLocated(held!)).toBe(false);
  });
});

describe("attaching a fix", () => {
  it("signs the draft and promotes it to the sync queue", async () => {
    await seedDraft("d-1");

    const result = await queue.attachFix("d-1", { ...HUB, at: minutesAfter(2) }, signer);

    expect(result.outcome).toBe("located");
    const [promoted] = await queue.pending();
    expect(promoted?.status).toBe("queued");
    expect(promoted?.payload.lat).toBe(HUB.lat);
    expect(promoted?.signature).toBe("signed:6.5244,3.3792");
    expect(queue.isLocated(promoted!)).toBe(true);
  });

  it("signs the coordinates that were actually attached", async () => {
    await seedDraft("d-1");
    await queue.attachFix("d-1", { lat: 1.5, lng: 2.5, at: minutesAfter(1) }, signer);

    const [promoted] = await queue.pending();
    expect(promoted?.signature).toBe("signed:1.5,2.5");
  });

  it("settles several drafts from one fix", async () => {
    await seedDraft("d-1");
    await seedDraft("d-2");

    for (const draft of await queue.awaitingGps()) {
      await queue.attachFix(draft.id, { ...HUB, at: minutesAfter(3) }, signer);
    }

    expect(await queue.awaitingGps()).toHaveLength(0);
    expect(await queue.pending()).toHaveLength(2);
  });

  it("accepts a fix at the edge of the window", async () => {
    await seedDraft("d-1");
    const atEdge = new Date(
      new Date(CAPTURED_AT).getTime() + queue.FIX_ATTACH_WINDOW_MS,
    ).toISOString();

    const result = await queue.attachFix("d-1", { ...HUB, at: atEdge }, signer);
    expect(result.outcome).toBe("located");
  });
});

describe("the honesty bound", () => {
  it("refuses a fix taken long after the capture", async () => {
    await seedDraft("d-1");

    const result = await queue.attachFix("d-1", { ...HUB, at: minutesAfter(240) }, signer);

    expect(result.outcome).toBe("expired");
  });

  it("leaves an expired draft unsigned, unsent and explained", async () => {
    await seedDraft("d-1");
    await queue.attachFix("d-1", { ...HUB, at: minutesAfter(240) }, signer);

    const [stranded] = await queue.awaitingGps();
    expect(stranded?.signature).toBeNull();
    expect(stranded?.payload.lat).toBeUndefined();
    expect(stranded?.status).toBe("awaiting-gps");
    expect(stranded?.lastError).toMatch(/30 minutes/);
    expect(await queue.pending()).toHaveLength(0);
  });

  it("never overwrites a position already signed for", async () => {
    await seedDraft("d-1");
    await queue.attachFix("d-1", { ...HUB, at: minutesAfter(1) }, signer);

    // A second fix must not rewrite a record whose signature is already committed.
    const second = await queue.attachFix("d-1", { lat: 9.9, lng: 9.9, at: minutesAfter(2) }, signer);

    expect(second.outcome).toBe("missing");
    const [promoted] = await queue.pending();
    expect(promoted?.payload.lat).toBe(HUB.lat);
  });

  it("counts held drafts separately from waiting ones", async () => {
    await seedDraft("d-1");
    await seedDraft("d-2");
    await queue.attachFix("d-2", { ...HUB, at: minutesAfter(1) }, signer);

    const counts = await queue.counts();
    expect(counts["awaiting-gps"]).toBe(1);
    expect(counts.queued).toBe(1);
  });
});
