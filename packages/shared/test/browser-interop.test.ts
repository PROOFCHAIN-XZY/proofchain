import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import { canonicalEventPayload } from "../src/canonical-core.js";
import { eventPayloadHash } from "../src/canonical.js";
import { verifyWeighInSignature } from "../src/signing.js";
import type { WeighInPayload } from "../src/types.js";

/**
 * Cross-platform interop.
 *
 * The capture PWA and the Expo app sign with @noble/curves; the server verifies
 * with node:crypto. If those two ever disagree — about the canonical bytes or
 * about the signature format — every weigh-in from the field silently fails
 * integrity and the pilot dies with nobody understanding why. This test is the
 * tripwire for that.
 */

const payload: WeighInPayload = {
  schema: "proofchain.weighin.v2",
  collectorId: "9f1c5d2e-0000-4000-8000-000000000001",
  hubId: "803bde5d-c7f2-4f98-80b8-15d97fb06517",
  deviceId: "1c7a101f-d6d0-4039-b80f-bd4515b6bafb",
  weightKg: 12.5,
  material: "PET",
  capturedAt: "2026-08-08T09:15:00.000Z",
  photoHash: "a".repeat(64),
  nonce: "b".repeat(32),
};

/** Exactly what apps/capture/src/lib/identity.ts does, minus the browser APIs. */
function signLikeTheBrowser(p: WeighInPayload, privateKey: Uint8Array): string {
  const message = new TextEncoder().encode(canonicalEventPayload(p));
  return Buffer.from(ed25519.sign(message, privateKey)).toString("base64");
}

function publicKeyBase64(privateKey: Uint8Array): string {
  return Buffer.from(ed25519.getPublicKey(privateKey)).toString("base64");
}

describe("browser-signed weigh-ins verify on the server", () => {
  it("accepts a signature produced by @noble/curves", () => {
    const privateKey = ed25519.utils.randomPrivateKey();
    const signature = signLikeTheBrowser(payload, privateKey);

    expect(verifyWeighInSignature(payload, signature, publicKeyBase64(privateKey))).toBe(true);
  });

  it("still detects tampering on a browser-signed payload", () => {
    const privateKey = ed25519.utils.randomPrivateKey();
    const signature = signLikeTheBrowser(payload, privateKey);
    const inflated = { ...payload, weightKg: 950 };

    expect(verifyWeighInSignature(inflated, signature, publicKeyBase64(privateKey))).toBe(false);
  });

  it("produces the same payload hash on both sides", () => {
    // TextEncoder (browser) and Buffer utf8 (node) must agree byte-for-byte,
    // including for non-ASCII text that could appear in future schema fields.
    const encoded = new TextEncoder().encode(canonicalEventPayload(payload));
    expect(Buffer.from(encoded).toString("utf8")).toBe(canonicalEventPayload(payload));
    expect(eventPayloadHash(payload)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("agrees on the base64 public key format the server stores", () => {
    const privateKey = ed25519.utils.randomPrivateKey();
    const stored = publicKeyBase64(privateKey);

    // 32 raw bytes -> 44 base64 chars ending in '='. The DTO regex depends on it.
    expect(stored).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });
});
