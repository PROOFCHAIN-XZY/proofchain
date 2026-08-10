import { describe, expect, it } from "vitest";
import {
  generateDeviceKeypair,
  signWeighIn,
  verifyWeighInSignature,
  publicKeyToBase64,
} from "../src/signing.js";
import type { WeighInPayload } from "../src/types.js";

const payload: WeighInPayload = {
  schema: "proofchain.weighin.v1",
  collectorId: "9f1c5d2e-0000-4000-8000-000000000001",
  hubId: "hub-nairobi-01",
  deviceId: "device-abc",
  weightKg: 12.5,
  material: "PET",
  lat: -1.286389,
  lng: 36.817223,
  capturedAt: "2026-08-08T09:15:00.000Z",
  photoHash: "a".repeat(64),
  nonce: "b".repeat(32),
};

/**
 * Anchoring proves a record was not altered *after the fact*. Signing at the
 * point of capture is what ties the record to a specific enrolled device, so a
 * weigh-in cannot be minted by anyone who merely reaches the API.
 */
describe("device signatures", () => {
  it("verifies a signature produced by the matching device key", () => {
    const kp = generateDeviceKeypair();
    const sig = signWeighIn(payload, kp.privateKey);
    expect(verifyWeighInSignature(payload, sig, kp.publicKey)).toBe(true);
  });

  it("rejects a signature from a different device", () => {
    const enrolled = generateDeviceKeypair();
    const attacker = generateDeviceKeypair();
    const sig = signWeighIn(payload, attacker.privateKey);
    expect(verifyWeighInSignature(payload, sig, enrolled.publicKey)).toBe(false);
  });

  it("rejects a payload whose weight was inflated after signing", () => {
    const kp = generateDeviceKeypair();
    const sig = signWeighIn(payload, kp.privateKey);
    const inflated = { ...payload, weightKg: 125.0 };
    expect(verifyWeighInSignature(inflated, sig, kp.publicKey)).toBe(false);
  });

  it("rejects a payload whose GPS was moved after signing", () => {
    const kp = generateDeviceKeypair();
    const sig = signWeighIn(payload, kp.privateKey);
    const moved = { ...payload, lat: 0, lng: 0 };
    expect(verifyWeighInSignature(moved, sig, kp.publicKey)).toBe(false);
  });

  it("survives key round-tripping through the base64 form stored in Postgres", () => {
    const kp = generateDeviceKeypair();
    const sig = signWeighIn(payload, kp.privateKey);
    const stored = publicKeyToBase64(kp.publicKey);
    expect(verifyWeighInSignature(payload, sig, stored)).toBe(true);
  });

  it("returns false rather than throwing on a malformed signature", () => {
    const kp = generateDeviceKeypair();
    expect(verifyWeighInSignature(payload, "not-base64-!!", kp.publicKey)).toBe(false);
    expect(verifyWeighInSignature(payload, "", kp.publicKey)).toBe(false);
  });

  it("returns false rather than throwing on a malformed public key", () => {
    const kp = generateDeviceKeypair();
    const sig = signWeighIn(payload, kp.privateKey);
    expect(verifyWeighInSignature(payload, sig, "garbage")).toBe(false);
  });
});
