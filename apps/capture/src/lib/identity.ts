import { ed25519 } from "@noble/curves/ed25519";
import { sha256 } from "@noble/hashes/sha2";
import { canonicalEventPayload } from "@shared/canonical";
import type { WeighInPayload } from "@shared/types";

/**
 * Device identity and signing, in the browser.
 *
 * The private key never leaves this device and is never sent anywhere. What the
 * operator enrols is the public key; from then on, a weigh-in is only credible
 * because this key signed it. That is the source-level half of the integrity
 * story — anchoring only covers what happens after we receive the record.
 *
 * ed25519 comes from @noble rather than WebCrypto because WebCrypto's Ed25519
 * support is still uneven across the Android browsers a field phone will run.
 */

const STORAGE_KEY = "proofchain.device.identity.v1";

export interface DeviceIdentity {
  privateKeyHex: string;
  publicKeyBase64: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Load the device key, generating one on first run. */
export function loadOrCreateIdentity(): DeviceIdentity {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) return JSON.parse(stored) as DeviceIdentity;

  const privateKey = ed25519.utils.randomPrivateKey();
  const publicKey = ed25519.getPublicKey(privateKey);

  const identity: DeviceIdentity = {
    privateKeyHex: toHex(privateKey),
    publicKeyBase64: toBase64(publicKey),
  };

  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
  return identity;
}

/** Destroys the device's ability to sign. Used when a phone is handed on. */
export function resetIdentity(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * Sign a weigh-in. The message is the canonical payload string — the exact same
 * encoder the server uses to verify, imported from the shared package.
 */
export function signWeighIn(payload: WeighInPayload, identity: DeviceIdentity): string {
  const message = new TextEncoder().encode(canonicalEventPayload(payload));
  const signature = ed25519.sign(message, fromHex(identity.privateKeyHex));
  return toBase64(signature);
}

/** sha256 of the photo bytes; the photo itself stays on the device and in blob storage. */
export async function hashPhoto(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer());
  return toHex(sha256(buffer));
}

export function randomNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return toHex(bytes);
}
