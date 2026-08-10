import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import * as Location from "expo-location";
import * as Network from "expo-network";
import * as SecureStore from "expo-secure-store";
import * as FileSystem from "expo-file-system";
import { sha256 } from "@noble/hashes/sha2";
import type { KeyValueStore } from "./storage";
import { toHex, type SecureStorePort } from "./identity";

/**
 * The only module that touches Expo APIs directly. Everything above it depends
 * on the ports these adapters satisfy, which is what lets the queue, sync and
 * signing logic be exercised in Node.
 */

/** Weigh-in queue: durable app storage. */
export const appStore: KeyValueStore = {
  getItem: (key) => AsyncStorage.getItem(key),
  setItem: (key, value) => AsyncStorage.setItem(key, value),
  removeItem: (key) => AsyncStorage.removeItem(key),
};

/** Device private key: the platform keystore, never plain app storage. */
export const secureStore: SecureStorePort = {
  getItemAsync: (key) => SecureStore.getItemAsync(key),
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value),
  deleteItemAsync: (key) => SecureStore.deleteItemAsync(key),
};

export function randomBytes(n: number): Uint8Array {
  return Crypto.getRandomBytes(n);
}

export function randomNonce(): string {
  return toHex(Crypto.getRandomBytes(16));
}

export async function isOnline(): Promise<boolean> {
  const state = await Network.getNetworkStateAsync();
  return Boolean(state.isConnected && state.isInternetReachable !== false);
}

export interface Fix {
  lat: number;
  lng: number;
  accuracyM: number | null;
}

/**
 * A GPS fix, or an explicit failure.
 *
 * Capture must not fall back to a stale or invented position: the geofence check
 * is one of the few things standing between the platform and a fabricated tonne,
 * so a weigh-in with no fix is better refused than recorded at the wrong place.
 */
export async function currentFix(): Promise<Fix> {
  const { status } = await Location.requestForegroundPermissionsAsync();
  if (status !== "granted") throw new Error("location permission denied");

  const position = await Location.getCurrentPositionAsync({
    accuracy: Location.Accuracy.High,
  });

  return {
    lat: position.coords.latitude,
    lng: position.coords.longitude,
    accuracyM: position.coords.accuracy ?? null,
  };
}

/**
 * Hash the photo without transmitting it. The bytes stay on the phone; only the
 * digest is signed and sent, so the record is verifiable without shipping images
 * over a metered field connection.
 */
export async function hashPhotoFile(uri: string): Promise<string> {
  const base64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });

  const binary = globalThis.atob
    ? globalThis.atob(base64)
    : Buffer.from(base64, "base64").toString("binary");

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  return toHex(sha256(bytes));
}
