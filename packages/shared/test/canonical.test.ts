import { describe, expect, it } from "vitest";
import { canonicalize, canonicalEventPayload, eventPayloadHash } from "../src/canonical.js";
import type { WeighInPayload } from "../src/types.js";

const base: WeighInPayload = {
  schema: "proofchain.weighin.v2",
  collectorId: "9f1c5d2e-0000-4000-8000-000000000001",
  hubId: "hub-nairobi-01",
  deviceId: "device-abc",
  weightKg: 12.5,
  material: "PET",
  capturedAt: "2026-08-08T09:15:00.000Z",
  photoHash: "a".repeat(64),
  nonce: "b".repeat(32),
};

describe("canonicalize", () => {
  it("orders keys deterministically regardless of insertion order", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
  });

  it("orders nested object keys too", () => {
    expect(canonicalize({ x: { b: 1, a: 2 } })).toBe(canonicalize({ x: { a: 2, b: 1 } }));
  });

  it("preserves array order (arrays are sequences, not sets)", () => {
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it("emits no incidental whitespace", () => {
    expect(canonicalize({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}');
  });

  it("rejects values that cannot be canonicalised safely", () => {
    expect(() => canonicalize({ a: undefined } as never)).toThrow();
    expect(() => canonicalize({ a: Number.NaN })).toThrow();
    expect(() => canonicalize({ a: Infinity })).toThrow();
  });
});

describe("canonicalEventPayload", () => {
  it("is stable across key ordering of the input object", () => {
    const shuffled = Object.fromEntries(
      Object.entries(base).reverse(),
    ) as unknown as WeighInPayload;
    expect(canonicalEventPayload(shuffled)).toBe(canonicalEventPayload(base));
  });

  it("quantises weight so float noise cannot break a signature", () => {
    const jittered = { ...base, weightKg: 12.5000000001 };
    expect(canonicalEventPayload(jittered)).toBe(canonicalEventPayload(base));
  });

  it("is NOT ambiguous when a field contains the delimiter character", () => {
    // A naive "join with |" encoding lets a crafted hubId impersonate another
    // field boundary. JSON escaping must keep these distinct.
    const a = canonicalEventPayload({ ...base, hubId: "hub|X", deviceId: "d" });
    const b = canonicalEventPayload({ ...base, hubId: "hub", deviceId: "X|d" });
    expect(a).not.toBe(b);
  });

  it("changes when any material field changes", () => {
    const fields: Array<Partial<WeighInPayload>> = [
      { weightKg: 12.6 },
      { material: "HDPE" },
      { capturedAt: "2026-08-08T09:16:00.000Z" },
      { photoHash: "c".repeat(64) },
      { collectorId: "9f1c5d2e-0000-4000-8000-000000000002" },
      { hubId: "hub-nairobi-02" },
      { deviceId: "device-xyz" },
      { nonce: "d".repeat(32) },
    ];
    const baseline = canonicalEventPayload(base);
    for (const patch of fields) {
      expect(canonicalEventPayload({ ...base, ...patch }), JSON.stringify(patch)).not.toBe(
        baseline,
      );
    }
  });
});

describe("eventPayloadHash", () => {
  it("produces a 64-char hex digest", () => {
    expect(eventPayloadHash(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches for two independently constructed identical payloads", () => {
    expect(eventPayloadHash({ ...base })).toBe(eventPayloadHash(base));
  });
});
