import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Regression coverage for the two functions that actually talk to Stellar.
 * They previously had zero unit tests — everything else in anchor.test.ts is
 * pure guards. These tests pin down:
 *
 *  - anchorBatchRoot reports exactly the ledger Horizon returned (no unsafe
 *    `as` cast silently coercing a missing/malformed field to the
 *    misleadingly "valid-looking" ledger number 0), and refuses to report an
 *    anchor at all if Horizon ever marks a resolved submission unsuccessful.
 *  - verifyAnchorOnLedger can only return `verified: true` when the
 *    transaction itself was found AND at least one independent on-chain
 *    reference (memo or data entry) confirms the expected root. A matching
 *    data entry alone — which could in principle be left over from an
 *    unrelated write — must never verify a transaction that was not found.
 */

const mocks = vi.hoisted(() => {
  const server = {
    loadAccount: vi.fn(),
    submitTransaction: vi.fn(),
    transactions: vi.fn(),
  };
  const ServerCtor = vi.fn(() => server);
  return { server, ServerCtor };
});

vi.mock("@stellar/stellar-sdk", () => ({
  BASE_FEE: "100",
  Networks: {
    TESTNET: "Test SDF Network ; September 2015",
    PUBLIC: "Public Global Stellar Network ; September 2015",
  },
  Keypair: {
    fromSecret: vi.fn(() => ({ publicKey: () => "GFAKEPUBLICKEY" })),
  },
  Memo: {
    hash: vi.fn((buf: Buffer) => ({ type: "hash", value: buf })),
  },
  Operation: {
    manageData: vi.fn((args: unknown) => ({ type: "manageData", ...(args as object) })),
  },
  TransactionBuilder: vi.fn().mockImplementation(() => {
    const builder = {
      addOperation: vi.fn(),
      addMemo: vi.fn(),
      setTimeout: vi.fn(),
      build: vi.fn(() => ({ sign: vi.fn() })),
    };
    builder.addOperation.mockReturnValue(builder);
    builder.addMemo.mockReturnValue(builder);
    builder.setTimeout.mockReturnValue(builder);
    return builder;
  }),
  Horizon: { Server: mocks.ServerCtor },
}));

const { anchorBatchRoot, verifyAnchorOnLedger } = await import("../src/anchor");

const config = {
  horizonUrl: "https://horizon-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  secret: "SFAKESECRET",
};

beforeEach(() => {
  mocks.server.loadAccount.mockReset();
  mocks.server.submitTransaction.mockReset();
  mocks.server.transactions.mockReset();
});

describe("anchorBatchRoot", () => {
  it("returns exactly the ledger Horizon reported, read off the typed SDK response", async () => {
    mocks.server.loadAccount.mockResolvedValue({});
    mocks.server.submitTransaction.mockResolvedValue({
      hash: "deadbeef",
      ledger: 123456,
      successful: true,
    });

    const result = await anchorBatchRoot("a".repeat(64), "batch-1", config);

    expect(result.stellarTxHash).toBe("deadbeef");
    expect(result.stellarLedger).toBe(123456);
  });

  it("refuses to report an anchor when Horizon marks the resolved submission unsuccessful", async () => {
    mocks.server.loadAccount.mockResolvedValue({});
    mocks.server.submitTransaction.mockResolvedValue({
      hash: "deadbeef",
      ledger: 123456,
      successful: false,
    });

    await expect(anchorBatchRoot("a".repeat(64), "batch-1", config)).rejects.toThrow(
      /unsuccessful/,
    );
  });
});

describe("verifyAnchorOnLedger", () => {
  const expectedRoot = "b".repeat(64);
  const rootBase64 = Buffer.from(expectedRoot, "hex").toString("base64");

  it("verifies when the found transaction's memo matches the expected root", async () => {
    mocks.server.transactions.mockReturnValue({
      transaction: () => ({
        call: () =>
          Promise.resolve({ ledger_attr: 42, memo_type: "hash", memo: rootBase64 }),
      }),
    });
    mocks.server.loadAccount.mockResolvedValue({ data_attr: {} });

    const result = await verifyAnchorOnLedger("tx1", expectedRoot, "GPUB", "key", config);

    expect(result).toEqual({
      txFound: true,
      memoMatches: true,
      dataEntryMatches: false,
      ledger: 42,
      verified: true,
    });
  });

  it("never verifies off a matching data entry alone when the transaction cannot be found", async () => {
    // A stale/unrelated data entry must not be enough on its own — the
    // transaction record is the primary, falsifiable source of truth.
    mocks.server.transactions.mockReturnValue({
      transaction: () => ({ call: () => Promise.reject(new Error("not found")) }),
    });
    mocks.server.loadAccount.mockResolvedValue({ data_attr: { key: rootBase64 } });

    const result = await verifyAnchorOnLedger("tx1", expectedRoot, "GPUB", "key", config);

    expect(result.dataEntryMatches).toBe(true);
    expect(result.txFound).toBe(false);
    expect(result.verified).toBe(false);
  });

  it("does not verify when the transaction is found but neither memo nor data entry match", async () => {
    mocks.server.transactions.mockReturnValue({
      transaction: () => ({
        call: () => Promise.resolve({ ledger_attr: 42, memo_type: "text", memo: "unrelated" }),
      }),
    });
    mocks.server.loadAccount.mockResolvedValue({ data_attr: { key: "c".repeat(44) } });

    const result = await verifyAnchorOnLedger("tx1", expectedRoot, "GPUB", "key", config);

    expect(result.memoMatches).toBe(false);
    expect(result.dataEntryMatches).toBe(false);
    expect(result.verified).toBe(false);
  });

  it("degrades to unverified, not a thrown error, when Horizon is unreachable for both lookups", async () => {
    mocks.server.transactions.mockReturnValue({
      transaction: () => ({ call: () => Promise.reject(new Error("ECONNREFUSED")) }),
    });
    mocks.server.loadAccount.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await verifyAnchorOnLedger("tx1", expectedRoot, "GPUB", "key", config);

    expect(result).toEqual({
      txFound: false,
      memoMatches: false,
      dataEntryMatches: false,
      ledger: null,
      verified: false,
    });
  });
});
