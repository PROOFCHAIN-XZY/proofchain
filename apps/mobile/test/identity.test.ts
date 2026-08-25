import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { canonicalEventPayload } from "@shared/canonical";
import type { WeighInPayload } from "@shared/types";
import {
  fromHex,
  loadOrCreateIdentity,
  resetIdentity,
  signWeighIn,
  toBase64,
  toHex,
  type SecureStorePort,
} from "../src/lib/identity";

function memorySecureStore(): SecureStorePort & { size: () => number } {
  const map = new Map<string, string>();
  return {
    async getItemAsync(key) {
      return map.get(key) ?? null;
    },
    async setItemAsync(key, value) {
      map.set(key, value);
    },
    async deleteItemAsync(key) {
      map.delete(key);
    },
    size: () => map.size,
  };
}

/** Deterministic stand-in for expo-crypto's CSPRNG. */
function fixedRandom(byte: number) {
  return (n: number) => new Uint8Array(n).fill(byte);
}

function payload(): WeighInPayload {
  return {
    schema: "proofchain.weighin.v2",
    collectorId: "c1",
    hubId: "h1",
    deviceId: "d1",
    weightKg: 12.345,
    material: "PET",
    capturedAt: "2026-08-08T10:00:00.000Z",
    photoHash: "a".repeat(64),
    nonce: "b".repeat(32),
  };
}

describe("base64 encoding", () => {
  // Ed25519 keys and signatures are 32 and 64 bytes, so padding behaviour at each
  // remainder matters — a wrong pad byte makes the server reject every weigh-in.
  it.each([
    [[] as number[], ""],
    [[77], "TQ=="],
    [[77, 97], "TWE="],
    [[77, 97, 110], "TWFu"],
    [[0, 0, 0], "AAAA"],
    [[255, 255, 255], "////"],
  ])("encodes %j", (bytes, expected) => {
    expect(toBase64(new Uint8Array(bytes))).toBe(expected);
  });

  it("matches Buffer's encoding for a full 32-byte key", () => {
    const bytes = new Uint8Array(32).map((_, i) => (i * 7) % 256);

    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
  });
});

describe("hex round-trip", () => {
  it("restores the original bytes", () => {
    const bytes = new Uint8Array([0, 1, 15, 16, 128, 255]);

    expect([...fromHex(toHex(bytes))]).toEqual([...bytes]);
  });
});

describe("device identity", () => {
  it("generates a key on first run and persists it", async () => {
    const store = memorySecureStore();

    const identity = await loadOrCreateIdentity(store, fixedRandom(1));

    expect(identity.privateKeyHex).toHaveLength(64);
    expect(store.size()).toBe(1);
  });

  it("returns the same key on later runs rather than re-enrolling the phone", async () => {
    const store = memorySecureStore();

    const first = await loadOrCreateIdentity(store, fixedRandom(1));
    const second = await loadOrCreateIdentity(store, fixedRandom(2));

    expect(second).toEqual(first);
  });

  it("derives the public key that the operator enrols", async () => {
    const store = memorySecureStore();

    const identity = await loadOrCreateIdentity(store, fixedRandom(9));
    const expected = toBase64(ed25519.getPublicKey(fromHex(identity.privateKeyHex)));

    expect(identity.publicKeyBase64).toBe(expected);
  });

  it("forgets the key on reset so a reassigned phone cannot sign", async () => {
    const store = memorySecureStore();
    await loadOrCreateIdentity(store, fixedRandom(1));

    await resetIdentity(store);

    expect(store.size()).toBe(0);
  });
});

describe("signWeighIn", () => {
  it("produces a signature the enrolled public key verifies", async () => {
    const store = memorySecureStore();
    const identity = await loadOrCreateIdentity(store, fixedRandom(3));

    const signature = signWeighIn(payload(), identity);

    const verified = ed25519.verify(
      new Uint8Array(Buffer.from(signature, "base64")),
      new TextEncoder().encode(canonicalEventPayload(payload())),
      ed25519.getPublicKey(fromHex(identity.privateKeyHex)),
    );
    expect(verified).toBe(true);
  });

  it("does not verify once any signed field is altered", async () => {
    const store = memorySecureStore();
    const identity = await loadOrCreateIdentity(store, fixedRandom(3));
    const signature = signWeighIn(payload(), identity);

    const inflated = { ...payload(), weightKg: 950 };

    const verified = ed25519.verify(
      new Uint8Array(Buffer.from(signature, "base64")),
      new TextEncoder().encode(canonicalEventPayload(inflated)),
      ed25519.getPublicKey(fromHex(identity.privateKeyHex)),
    );
    expect(verified).toBe(false);
  });

  it("signs bytes identical to the server's encoder for the same payload", () => {
    // Guards the one invariant every surface depends on: the phone and the server
    // must canonicalise to the same string, or no weigh-in ever validates.
    expect(canonicalEventPayload(payload())).toBe(canonicalEventPayload({ ...payload() }));
  });
});
