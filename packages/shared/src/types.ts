/**
 * Shared domain types — the five core entities from the project plan, plus the
 * wire payloads that cross the device/server boundary.
 *
 * These are the real IP: they exist to satisfy an auditor's chain-of-custody
 * demands. Build backwards from the audit artifact.
 */

/**
 * A material code, as signed into the payload.
 *
 * This was a closed union of six literals until the catalogue moved into the
 * database. It cannot stay one: an operator can now add a code at runtime, and a
 * union compiled last week has no way to name it. Validation therefore moved
 * from the type system to two runtime layers — `MATERIAL_CODE_PATTERN` for
 * shape, and a catalogue lookup for existence — which is where it has to live
 * once the set is data rather than code.
 *
 * The wire format did not change. A code was serialised as a JSON string before
 * and is serialised as a JSON string now, so every root anchored under the old
 * union still recomputes identically. See `./materials.js` for why codes are
 * append-only.
 */
export type MaterialType = string;

export const BATCH_STATUSES = ["open", "sealed", "processed", "sold"] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];

export const KYC_LEVELS = ["none", "basic", "verified"] as const;
export type KycLevel = (typeof KYC_LEVELS)[number];

export type StellarNetwork = "testnet" | "public";

/**
 * Integrity verdicts attached to every event by the server-side v1 checks.
 * `pass` does not mean "true tonne" — it means "nothing detectably wrong".
 */
export const INTEGRITY_CHECKS = [
  "signature_valid",
  "device_enrolled",
  "weight_in_range",
  "not_duplicate",
  "clock_plausible",
  "photo_present",
] as const;
export type IntegrityCheck = (typeof INTEGRITY_CHECKS)[number];

export type IntegrityOutcome = "pass" | "warn" | "fail";

export interface IntegrityFinding {
  check: IntegrityCheck;
  outcome: IntegrityOutcome;
  detail?: string;
}

export interface IntegrityVerdict {
  /** `fail` on any hard check means the event is quarantined, never batched. */
  outcome: IntegrityOutcome;
  findings: IntegrityFinding[];
}

/** Who did the collection work. */
export interface Collector {
  id: string;
  name: string;
  phone: string;
  cooperativeId?: string | null;
  kycLevel: KycLevel;
  active: boolean;
  createdAt: string;
}

/** An enrolled capture device. Its public key is the root of event authenticity. */
export interface Device {
  id: string;
  collectorId: string;
  label: string;
  publicKeyBase64: string;
  enrolledAt: string;
  revokedAt?: string | null;
}

/** A physical collection hub. */
export interface Hub {
  id: string;
  name: string;
  /** Sanity bounds for a single weigh-in at this hub, in kilograms. */
  minWeightKg: number;
  maxWeightKg: number;
}

/**
 * The exact bytes a device signs. Anything not in here is not covered by the
 * signature and must never be treated as attested.
 */
export interface WeighInPayload {
  schema: "proofchain.weighin.v2";
  collectorId: string;
  hubId: string;
  deviceId: string;
  weightKg: number;
  material: MaterialType;
  /** Device clock, ISO-8601 UTC. Cross-checked against server receipt time. */
  capturedAt: string;
  /** sha256 of the weigh-in photo bytes; the photo itself stays off-chain. */
  photoHash: string;
  /** Random per-capture value; makes replay of an identical weigh-in detectable. */
  nonce: string;
}

/** What the device actually POSTs. */
export interface WeighInSubmission {
  payload: WeighInPayload;
  /** base64 ed25519 signature over the canonical payload. */
  signature: string;
}

/** The atomic verified fact, as persisted. */
export interface CollectionEvent {
  id: string;
  collectorId: string;
  hubId: string;
  deviceId: string;
  batchId?: string | null;
  weightKg: number;
  material: MaterialType;
  capturedAt: string;
  receivedAt: string;
  photoHash: string;
  photoUri?: string | null;
  nonce: string;
  signature: string;
  /** sha256 of the canonical payload — this is what the Merkle leaf derives from. */
  payloadHash: string;
  integrity: IntegrityVerdict;
  quarantined: boolean;
}

/** A group of events aggregated for processing / sale. */
export interface Batch {
  id: string;
  hubId: string;
  material: MaterialType;
  status: BatchStatus;
  totalWeightKg: number;
  eventCount: number;
  merkleRoot?: string | null;
  sealedAt?: string | null;
  createdAt: string;
}

/** Proves chain-of-custody between parties. */
export interface CustodyTransfer {
  id: string;
  batchId: string;
  fromParty: string;
  toParty: string;
  weightInKg: number;
  weightOutKg: number;
  /** weightIn - weightOut; must be small and explainable. */
  varianceKg: number;
  reason?: string | null;
  transferredAt: string;
}

/** Links off-chain data to its on-chain proof. */
export interface AnchorRecord {
  id: string;
  batchId: string;
  merkleRoot: string;
  stellarTxHash: string;
  stellarLedger: number;
  network: StellarNetwork;
  dataEntryKey: string;
  anchoredAt: string;
}

/**
 * How one attempt to anchor a batch ended.
 *
 * `unverified` is deliberately distinct from `failed`: the transaction was
 * submitted and may have cost a real fee, and it may still appear on the ledger
 * a moment later. Treating it as an outright failure would hide a case that
 * needs a human to look at Horizon.
 */
export type AnchorAttemptOutcome = "failed" | "unverified" | "succeeded";

/** One sibling step on the path from a leaf to the root. */
export interface MerkleProofStep {
  hash: string;
  /** Which side the sibling sits on. Position is part of the commitment. */
  side: "left" | "right";
}

/** What the verify endpoint hands an auditor. */
export interface EventVerification {
  eventId: string;
  batchId: string;
  leaf: string;
  proof: MerkleProofStep[];
  merkleRoot: string;
  proofValid: boolean;
  onChain: {
    network: StellarNetwork;
    txHash: string;
    ledger: number;
    explorerUrl: string;
    /** Set once the root has been read back off the ledger and compared. */
    rootMatchesLedger: boolean | null;
  } | null;
}
