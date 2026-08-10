import { describe, expect, it } from "vitest";
import {
  buildMerkleTree,
  hashInternal,
  hashLeaf,
  merkleProof,
  merkleRootHex,
  verifyMerkleProof,
} from "../src/merkle.js";

/**
 * The Merkle layer is the load-bearing part of the whole product: a buyer trusts
 * one on-chain root to speak for hundreds of off-chain weigh-ins. These tests pin
 * down the properties an auditor actually relies on.
 */

const leaves = (n: number) =>
  Array.from({ length: n }, (_, i) => hashLeaf(Buffer.from(`event-${i}`)));

describe("merkleRootHex", () => {
  it("rejects an empty leaf set rather than inventing a root", () => {
    expect(() => merkleRootHex([])).toThrow(/no leaves/i);
  });

  it("returns a 32-byte root for any leaf count", () => {
    for (const n of [1, 2, 3, 5, 8, 17, 64, 101]) {
      expect(merkleRootHex(leaves(n))).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("is deterministic for the same leaves in the same order", () => {
    expect(merkleRootHex(leaves(9))).toBe(merkleRootHex(leaves(9)));
  });

  it("changes if any single leaf changes (tamper-evidence)", () => {
    const original = leaves(6);
    const tampered = [...original];
    tampered[3] = hashLeaf(Buffer.from("event-3-TAMPERED"));
    expect(merkleRootHex(tampered)).not.toBe(merkleRootHex(original));
  });

  it("changes if leaf order changes (position is part of the commitment)", () => {
    const original = leaves(6);
    const reordered = [original[1]!, original[0]!, ...original.slice(2)];
    expect(merkleRootHex(reordered)).not.toBe(merkleRootHex(original));
  });
});

describe("merkleProof / verifyMerkleProof", () => {
  it("proves every leaf of trees of many shapes, including odd levels", () => {
    for (const n of [1, 2, 3, 4, 5, 7, 8, 9, 16, 33]) {
      const ls = leaves(n);
      const root = merkleRootHex(ls);
      for (let i = 0; i < n; i++) {
        const proof = merkleProof(ls, i);
        expect(verifyMerkleProof(ls[i]!, proof, root), `n=${n} i=${i}`).toBe(true);
      }
    }
  });

  it("rejects a proof for a leaf that is not in the tree", () => {
    const ls = leaves(8);
    const root = merkleRootHex(ls);
    const proof = merkleProof(ls, 2);
    const forged = hashLeaf(Buffer.from("never-collected"));
    expect(verifyMerkleProof(forged, proof, root)).toBe(false);
  });

  it("rejects a proof whose sibling hashes were altered", () => {
    const ls = leaves(8);
    const root = merkleRootHex(ls);
    const proof = merkleProof(ls, 5);
    const tampered = proof.map((s, i) =>
      i === 0 ? { ...s, hash: "00".repeat(32) } : s,
    );
    expect(verifyMerkleProof(ls[5]!, tampered, root)).toBe(false);
  });

  it("rejects a proof replayed against a different root", () => {
    const ls = leaves(8);
    const proof = merkleProof(ls, 1);
    const otherRoot = merkleRootHex(leaves(9));
    expect(verifyMerkleProof(ls[1]!, proof, otherRoot)).toBe(false);
  });

  it("rejects a proof whose sibling side flags were flipped", () => {
    const ls = leaves(8);
    const root = merkleRootHex(ls);
    const proof = merkleProof(ls, 3);
    const flipped = proof.map((s) => ({
      ...s,
      side: s.side === "left" ? ("right" as const) : ("left" as const),
    }));
    expect(verifyMerkleProof(ls[3]!, flipped, root)).toBe(false);
  });

  it("refuses to build a proof for an out-of-range index", () => {
    expect(() => merkleProof(leaves(4), 4)).toThrow(/range/i);
    expect(() => merkleProof(leaves(4), -1)).toThrow(/range/i);
  });
});

describe("second-preimage resistance", () => {
  /**
   * Classic Merkle attack: present an *internal node* as if it were a leaf.
   * Domain separation (leaves prefixed 0x00, internal nodes 0x01) is what stops
   * it — an attacker would need a payload whose leaf hash equals a given
   * internal node, which preimage resistance rules out.
   */
  it("hashes leaves and internal nodes in separate domains", () => {
    const a = hashLeaf(Buffer.from("event-a"));
    const b = hashLeaf(Buffer.from("event-b"));
    const concatenated = Buffer.concat([Buffer.from(a, "hex"), Buffer.from(b, "hex")]);

    // If leaves and nodes shared a domain, these two would be identical.
    expect(hashInternal(a, b)).not.toBe(hashLeaf(concatenated));
  });

  it("distinguishes a leaf hash from the raw payload hash", () => {
    const payload = Buffer.from("weight=12.5");
    expect(hashLeaf(payload)).not.toBe(payload.toString("hex"));
  });

  it("exposes tree levels that collapse to the root", () => {
    const tree = buildMerkleTree(leaves(4));
    expect(tree.levels).toHaveLength(3);
    expect(tree.levels.at(-1)).toEqual([tree.root]);
    expect(hashInternal(tree.levels[1]![0]!, tree.levels[1]![1]!)).toBe(tree.root);
  });
});
