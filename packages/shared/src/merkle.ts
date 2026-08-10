import { createHash } from "node:crypto";
import type { MerkleProofStep } from "./types.js";

/**
 * Merkle utilities — anchor only the ROOT of a sealed batch, keep per-event
 * proofs off-chain. Any single weigh-in stays independently verifiable against
 * one on-chain record, while raw data never touches the ledger (privacy + cost).
 *
 * Two design choices differ from the naive version, and both matter:
 *
 * 1. DOMAIN SEPARATION. Leaves are hashed with a 0x00 prefix, internal nodes
 *    with 0x01. Without this, a 32-byte internal node could be presented as if
 *    it were a leaf — a fraudster could "prove" a weigh-in that was really an
 *    intermediate hash (the classic Merkle second-preimage attack).
 *
 * 2. POSITIONAL PAIRING. Siblings are combined left-then-right as they sit in
 *    the tree, and each proof step records its side. Sorting the pair instead
 *    (a common shortcut) throws away position, so a proof would verify for
 *    orderings that never existed in the sealed batch.
 *
 * Odd nodes at a level are promoted unchanged rather than duplicated, which
 * avoids the duplicate-last-node ambiguity (CVE-2012-2459 in Bitcoin's tree).
 */

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

/** Hash arbitrary leaf data (e.g. an event's payloadHash) into a tree leaf. */
export function hashLeaf(data: Buffer | string): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  return createHash("sha256").update(LEAF_PREFIX).update(buf).digest("hex");
}

/** Combine two child hashes into their parent. Order is significant. */
export function hashInternal(leftHex: string, rightHex: string): string {
  return createHash("sha256")
    .update(NODE_PREFIX)
    .update(Buffer.from(leftHex, "hex"))
    .update(Buffer.from(rightHex, "hex"))
    .digest("hex");
}

export interface MerkleTree {
  /** levels[0] is the leaves; the last level holds exactly the root. */
  levels: string[][];
  root: string;
}

function assertLeaves(leafHexes: readonly string[]): void {
  if (leafHexes.length === 0) {
    throw new Error("cannot build a Merkle tree with no leaves");
  }
  for (const [i, h] of leafHexes.entries()) {
    if (!/^[0-9a-f]{64}$/.test(h)) {
      throw new Error(`leaf ${i} is not a 32-byte lowercase hex hash`);
    }
  }
}

export function buildMerkleTree(leafHexes: readonly string[]): MerkleTree {
  assertLeaves(leafHexes);

  const levels: string[][] = [[...leafHexes]];
  let current = levels[0]!;

  while (current.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < current.length; i += 2) {
      const left = current[i]!;
      const right = current[i + 1];
      // Lone trailing node is promoted, not paired with itself.
      next.push(right === undefined ? left : hashInternal(left, right));
    }
    levels.push(next);
    current = next;
  }

  return { levels, root: current[0]! };
}

export function merkleRootHex(leafHexes: readonly string[]): string {
  return buildMerkleTree(leafHexes).root;
}

/** Produce the sibling path proving `index` belongs to the tree. */
export function merkleProof(leafHexes: readonly string[], index: number): MerkleProofStep[] {
  assertLeaves(leafHexes);
  if (!Number.isInteger(index) || index < 0 || index >= leafHexes.length) {
    throw new RangeError(`leaf index ${index} out of range (0..${leafHexes.length - 1})`);
  }

  const { levels } = buildMerkleTree(leafHexes);
  const proof: MerkleProofStep[] = [];
  let idx = index;

  for (const level of levels.slice(0, -1)) {
    const isRightChild = idx % 2 === 1;
    const siblingIdx = isRightChild ? idx - 1 : idx + 1;
    const sibling = level[siblingIdx];

    // No sibling means this node was promoted untouched; nothing to record.
    if (sibling !== undefined) {
      proof.push({ hash: sibling, side: isRightChild ? "left" : "right" });
    }

    idx = Math.floor(idx / 2);
  }

  return proof;
}

/** Independently verify a leaf against a known root. Pure; no I/O, no state. */
export function verifyMerkleProof(
  leafHex: string,
  proof: readonly MerkleProofStep[],
  rootHex: string,
): boolean {
  if (!/^[0-9a-f]{64}$/.test(leafHex) || !/^[0-9a-f]{64}$/.test(rootHex)) return false;

  let acc = leafHex;
  for (const step of proof) {
    if (!/^[0-9a-f]{64}$/.test(step.hash)) return false;
    acc = step.side === "left" ? hashInternal(step.hash, acc) : hashInternal(acc, step.hash);
  }
  return acc === rootHex;
}
