import { describe, expect, it } from "vitest";
import { Networks } from "@stellar/stellar-sdk";
import { assertRoot, dataEntryKeyFor, loadAnchorConfig } from "../src/anchor";

/**
 * These cover the pure guards around anchoring — the places where a malformed
 * value would otherwise reach Horizon and either fail opaquely or, worse,
 * succeed while anchoring the wrong bytes.
 */

describe("assertRoot", () => {
  const validRoot = "a".repeat(64);

  it("accepts a 64-char lowercase hex root and returns 32 bytes", () => {
    const buffer = assertRoot(validRoot);

    expect(buffer).toHaveLength(32);
    expect(buffer.toString("hex")).toBe(validRoot);
  });

  it("rejects a root that is too short", () => {
    expect(() => assertRoot("abcd")).toThrow(/32-byte/);
  });

  it("rejects a root that is too long", () => {
    expect(() => assertRoot("a".repeat(65))).toThrow(/32-byte/);
  });

  it("rejects uppercase hex so anchored roots have one canonical form", () => {
    expect(() => assertRoot("A".repeat(64))).toThrow(/32-byte/);
  });

  it("rejects non-hex characters", () => {
    expect(() => assertRoot("z".repeat(64))).toThrow(/32-byte/);
  });

  it("rejects an empty string", () => {
    expect(() => assertRoot("")).toThrow(/32-byte/);
  });
});

describe("dataEntryKeyFor", () => {
  it("namespaces the batch id under a proofchain prefix", () => {
    expect(dataEntryKeyFor("abc-123")).toBe("proofchain:batch:abc-123");
  });

  it("stays within the 64-byte manageData key limit for a UUID batch id", () => {
    const key = dataEntryKeyFor("3f2504e0-4f89-11d3-9a0c-0305e82c3301");

    expect(Buffer.byteLength(key, "utf8")).toBeLessThanOrEqual(64);
  });

  it("throws rather than silently truncating an over-long id", () => {
    expect(() => dataEntryKeyFor("x".repeat(60))).toThrow(/exceeds 64 bytes/);
  });

  it("counts bytes, not characters, for multi-byte ids", () => {
    // 20 * 3 bytes + 18-byte prefix = 78 bytes, though only 38 characters.
    expect(() => dataEntryKeyFor("あ".repeat(20))).toThrow(/exceeds 64 bytes/);
  });
});

describe("loadAnchorConfig", () => {
  it("throws a directive error when the signing secret is absent", () => {
    expect(() => loadAnchorConfig({})).toThrow(/STELLAR_SECRET is not set/);
  });

  it("defaults to Horizon testnet when no endpoint is configured", () => {
    const config = loadAnchorConfig({ STELLAR_SECRET: "S-test" });

    expect(config.horizonUrl).toBe("https://horizon-testnet.stellar.org");
    expect(config.networkPassphrase).toBe(Networks.TESTNET);
  });

  it("honours explicit overrides for a non-default network", () => {
    const config = loadAnchorConfig({
      STELLAR_SECRET: "S-test",
      STELLAR_HORIZON_URL: "https://horizon.stellar.org",
      STELLAR_NETWORK_PASSPHRASE: Networks.PUBLIC,
    });

    expect(config.horizonUrl).toBe("https://horizon.stellar.org");
    expect(config.networkPassphrase).toBe(Networks.PUBLIC);
  });
});
