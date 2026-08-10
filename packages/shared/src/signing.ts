import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from "node:crypto";
import { canonicalEventPayload } from "./canonical.js";
import type { WeighInPayload } from "./types.js";

/**
 * Device signatures — integrity v1.
 *
 * Anchoring proves a record was not altered *after* it reached us. Signing at
 * the point of capture is the other half: it ties a weigh-in to a specific
 * enrolled device, so a record cannot simply be minted by anyone who can reach
 * the API. Neither proves the material on the scale was real — that is what
 * geofencing, photo evidence and duplicate detection are for.
 *
 * ed25519: small keys, deterministic signatures, no parameter choices to get
 * wrong, and available in Node and React Native (via expo-crypto/noble) alike.
 */

export type PublicKeyInput = KeyObject | string;

export interface DeviceKeypair {
  publicKey: KeyObject;
  privateKey: KeyObject;
}

export function generateDeviceKeypair(): DeviceKeypair {
  return generateKeyPairSync("ed25519");
}

/** Raw 32-byte public key, base64 — the form stored against a Device row. */
export function publicKeyToBase64(key: KeyObject): string {
  const der = key.export({ format: "der", type: "spki" }) as Buffer;
  // SPKI for ed25519 is a fixed 12-byte header followed by the raw key.
  return der.subarray(der.length - 32).toString("base64");
}

/** Private key in PKCS8 PEM — for test fixtures and device-side storage only. */
export function privateKeyToPem(key: KeyObject): string {
  return key.export({ format: "pem", type: "pkcs8" }) as string;
}

export function privateKeyFromPem(pem: string): KeyObject {
  return createPrivateKey(pem);
}

const ED25519_SPKI_HEADER = Buffer.from("302a300506032b6570032100", "hex");

/** Rebuild a KeyObject from the stored base64 raw key. */
export function publicKeyFromBase64(b64: string): KeyObject {
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== 32) {
    throw new Error(`expected a 32-byte ed25519 public key, got ${raw.length} bytes`);
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_HEADER, raw]),
    format: "der",
    type: "spki",
  });
}

function resolvePublicKey(key: PublicKeyInput): KeyObject {
  return typeof key === "string" ? publicKeyFromBase64(key) : key;
}

/** A fresh per-capture nonce. Replay of an identical weigh-in becomes visible. */
export function generateNonce(): string {
  return randomBytes(16).toString("hex");
}

export function signWeighIn(payload: WeighInPayload, privateKey: KeyObject): string {
  const message = Buffer.from(canonicalEventPayload(payload), "utf8");
  return cryptoSign(null, message, privateKey).toString("base64");
}

/**
 * Returns false — never throws — for malformed keys or signatures. Callers are
 * handling untrusted input from the field; a thrown error here would turn a
 * rejected weigh-in into a 500.
 */
export function verifyWeighInSignature(
  payload: WeighInPayload,
  signatureBase64: string,
  publicKey: PublicKeyInput,
): boolean {
  try {
    if (!signatureBase64) return false;

    const signature = Buffer.from(signatureBase64, "base64");
    if (signature.length !== 64) return false;

    const key = resolvePublicKey(publicKey);
    const message = Buffer.from(canonicalEventPayload(payload), "utf8");
    return cryptoVerify(null, message, key, signature);
  } catch {
    return false;
  }
}
