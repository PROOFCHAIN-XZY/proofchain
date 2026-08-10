import { ed25519 } from "@noble/curves/ed25519";
import { canonicalEventPayload } from "@shared/canonical";
import type { WeighInPayload } from "@shared/types";

/**
 * Device identity and signing.
 *
 * The private key is generated on the phone, stored in the platform keystore via
 * SecureStore, and never transmitted. What the operator enrols is the public key.
 * From then on a weigh-in is credible because this key signed it — that is the
 * source-level half of the integrity story, and it is the half that anchoring
 * cannot supply: the ledger only attests to what we received, not to who
 * produced it.
 *
 * ed25519 comes from @noble because React Native has no WebCrypto Ed25519.
 */

const IDENTITY_KEY = "proofchain.device.identity.v1";
/** Set once the operator enrols this key; the server rejects unknown devices. */
const DEVICE_META_KEY = "proofchain.device.meta.v1";

export interface DeviceIdentity {
  privateKeyHex: string;
  publicKeyBase64: string;
}

export interface DeviceMeta {
  deviceId: string;
  collectorId: string;
  collectorName: string;
  hubId: string;
  hubName: string;
  hubLat: number;
  hubLng: number;
}

export interface SecureStorePort {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toBase64(bytes: Uint8Array): string {
  // Buffer is unavailable in the RN runtime, so encode manually rather than
  // depending on a polyfill that may or may not be installed.
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] as number;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    const triple = (b0 << 16) | ((b1 ?? 0) << 8) | (b2 ?? 0);

    out += chars[(triple >> 18) & 63];
    out += chars[(triple >> 12) & 63];
    out += b1 === undefined ? "=" : chars[(triple >> 6) & 63];
    out += b2 === undefined ? "=" : chars[triple & 63];
  }
  return out;
}

export async function loadOrCreateIdentity(
  store: SecureStorePort,
  randomBytes: (n: number) => Uint8Array,
): Promise<DeviceIdentity> {
  const stored = await store.getItemAsync(IDENTITY_KEY);
  if (stored) return JSON.parse(stored) as DeviceIdentity;

  // Seeded from the platform CSPRNG (expo-crypto), not Math.random.
  const privateKey = randomBytes(32);
  const publicKey = ed25519.getPublicKey(privateKey);

  const identity: DeviceIdentity = {
    privateKeyHex: toHex(privateKey),
    publicKeyBase64: toBase64(publicKey),
  };

  await store.setItemAsync(IDENTITY_KEY, JSON.stringify(identity));
  return identity;
}

/** Destroys this phone's ability to sign — used when it is handed to someone else. */
export async function resetIdentity(store: SecureStorePort): Promise<void> {
  await store.deleteItemAsync(IDENTITY_KEY);
  await store.deleteItemAsync(DEVICE_META_KEY);
}

export async function loadDeviceMeta(store: SecureStorePort): Promise<DeviceMeta | null> {
  const raw = await store.getItemAsync(DEVICE_META_KEY);
  return raw ? (JSON.parse(raw) as DeviceMeta) : null;
}

export async function saveDeviceMeta(store: SecureStorePort, meta: DeviceMeta): Promise<void> {
  await store.setItemAsync(DEVICE_META_KEY, JSON.stringify(meta));
}

/**
 * Sign a weigh-in over the canonical payload string — byte-for-byte the same
 * encoder the server verifies with, imported from the shared package rather than
 * reimplemented here.
 */
export function signWeighIn(payload: WeighInPayload, identity: DeviceIdentity): string {
  const message = new TextEncoder().encode(canonicalEventPayload(payload));
  return toBase64(ed25519.sign(message, fromHex(identity.privateKeyHex)));
}
