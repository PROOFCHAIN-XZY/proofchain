import type { WeighInPayload } from "./types.js";

/**
 * Canonical serialisation — PURE. No Node built-ins, no crypto, no I/O.
 *
 * This file is deliberately dependency-free so the browser PWA, the Expo app and
 * the server can all import the exact same encoder. The bytes a device signs and
 * the bytes the server verifies must be identical; the surest way to guarantee
 * that is to have exactly one implementation, runnable everywhere.
 *
 * Encoding is JSON with sorted keys rather than a delimiter-joined string. A
 * delimiter encoding is ambiguous: hubId "hub|X" + deviceId "d" would collide
 * with hubId "hub" + deviceId "X|d". JSON escaping removes that attack class.
 */

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export function canonicalize(value: unknown): string {
  return encode(value);
}

function encode(value: unknown): string {
  if (value === null) return "null";

  const t = typeof value;

  if (t === "string") return JSON.stringify(value);
  if (t === "boolean") return value ? "true" : "false";

  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new TypeError(`cannot canonicalise non-finite number: ${String(n)}`);
    }
    // Normalise -0 to 0 so the two spellings cannot produce different hashes.
    return JSON.stringify(Object.is(n, -0) ? 0 : n);
  }

  if (Array.isArray(value)) {
    return `[${value.map(encode).join(",")}]`;
  }

  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const parts = keys.map((k) => {
      if (obj[k] === undefined) {
        throw new TypeError(`cannot canonicalise undefined at key "${k}"`);
      }
      return `${JSON.stringify(k)}:${encode(obj[k])}`;
    });
    return `{${parts.join(",")}}`;
  }

  throw new TypeError(`cannot canonicalise value of type ${t}`);
}

/** Grams. Weight is quantised so float noise cannot invalidate a signature. */
export const WEIGHT_DECIMALS = 3;

function quantise(n: number, decimals: number): number {
  if (!Number.isFinite(n)) {
    throw new TypeError(`cannot quantise non-finite number: ${String(n)}`);
  }
  return Number(n.toFixed(decimals));
}

/**
 * The exact string a device signs and the server re-derives. The field set is
 * fixed by `schema`; adding a field means a new schema version, never a silent
 * change — an old device and a new server must never disagree in silence.
 */
export function canonicalEventPayload(p: WeighInPayload): string {
  const normalised: Json = {
    schema: p.schema,
    collectorId: p.collectorId,
    hubId: p.hubId,
    deviceId: p.deviceId,
    weightKg: quantise(p.weightKg, WEIGHT_DECIMALS),
    material: p.material,
    capturedAt: p.capturedAt,
    photoHash: p.photoHash,
    nonce: p.nonce,
  };
  return canonicalize(normalised);
}
