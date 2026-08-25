import { createHash } from "node:crypto";
import { canonicalEventPayload } from "./canonical-core.js";
import type { WeighInPayload } from "./types.js";

/**
 * Node-side hashing over the canonical encoding.
 *
 * The encoder itself lives in `canonical-core.ts`, which is free of Node
 * built-ins so browsers and React Native import the identical implementation.
 * Only the hashing differs by platform (node:crypto here, WebCrypto there).
 */

export {
  canonicalize,
  canonicalEventPayload,
  WEIGHT_DECIMALS,
} from "./canonical-core.js";

export function sha256Hex(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function sha256(input: Buffer | string): Buffer {
  return createHash("sha256").update(input).digest();
}

/** sha256 of the canonical payload. Stored on the event; feeds the Merkle leaf. */
export function eventPayloadHash(p: WeighInPayload): string {
  return sha256Hex(canonicalEventPayload(p));
}
