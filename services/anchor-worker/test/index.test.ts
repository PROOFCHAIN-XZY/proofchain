import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Orchestration-level regression tests for the poll loop. `./anchor` and the
 * Stellar SDK are mocked out entirely here — the goal is to pin down two
 * loop-level guarantees that are easy to silently break while refactoring:
 *
 *  1. A batch that fails ledger verification is never handed to
 *     `recordAnchor` — an unverified anchor must never be mistaken for a
 *     recorded one.
 *  2. A single batch whose Horizon round-trip hangs cannot wedge the whole
 *     poll cycle forever; it must be abandoned (and retried next cycle)
 *     rather than blocking every other pending batch indefinitely.
 */

const mocks = vi.hoisted(() => ({
  anchorBatchRoot: vi.fn(),
  verifyAnchorOnLedger: vi.fn(),
  loadAnchorConfig: vi.fn(() => ({
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    secret: "SFAKESECRET",
  })),
}));

vi.mock("../src/anchor", () => mocks);

vi.mock("@stellar/stellar-sdk", () => ({
  Keypair: { fromSecret: vi.fn(() => ({ publicKey: () => "GPUB" })) },
}));

process.env.BACKEND_URL = "http://backend.test";
process.env.ANCHOR_TIMEOUT_MS = "30";
process.env.FETCH_TIMEOUT_MS = "5000";

const { anchorOnce } = await import("../src/index");

const pendingBatch = {
  id: "batch-1",
  merkleRoot: "a".repeat(64),
  totalWeightKg: 10,
  eventCount: 2,
  failedAttempts: 0,
  lastFailureDetail: null,
};

function pendingResponse(batches: unknown[]): Response {
  return new Response(JSON.stringify(batches), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  mocks.anchorBatchRoot.mockReset();
  mocks.verifyAnchorOnLedger.mockReset();
  vi.unstubAllGlobals();
});

describe("anchorOnce", () => {
  it("never records an anchor that ledger verification could not confirm", async () => {
    const fetchSpy = vi.fn((url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      if (url.endsWith("/batches/pending-anchor")) {
        return Promise.resolve(pendingResponse([pendingBatch]));
      }
      // The failure report is expected here; recording an anchor is not.
      if (url.endsWith("/anchor-failure")) {
        return Promise.resolve(new Response("{}", { status: 201 }));
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    mocks.anchorBatchRoot.mockResolvedValue({
      stellarTxHash: "tx1",
      stellarLedger: 10,
      network: "testnet",
      dataEntryKey: "proofchain:batch:batch-1",
      anchoredAt: new Date().toISOString(),
    });
    mocks.verifyAnchorOnLedger.mockResolvedValue({
      txFound: true,
      memoMatches: false,
      dataEntryMatches: false,
      ledger: null,
      verified: false,
    });

    const anchored = await anchorOnce();

    expect(anchored).toBe(0);

    // The distinction that matters: nothing was recorded as an anchor.
    const anchorWriteBacks = fetchSpy.mock.calls.filter(
      ([url, init]) => init?.method === "POST" && String(url).endsWith("/anchor"),
    );
    expect(anchorWriteBacks).toHaveLength(0);

    // But the attempt is reported, so the batch is not retried immediately and
    // an operator can see the transaction that may have cost a fee.
    const reports = fetchSpy.mock.calls.filter(([url]) => String(url).endsWith("/anchor-failure"));
    expect(reports).toHaveLength(1);
    expect(JSON.parse(String(reports[0]![1]?.body))).toMatchObject({
      outcome: "unverified",
      stellarTxHash: "tx1",
    });
  });

  it("abandons a batch whose Horizon submission hangs instead of stalling the cycle forever", async () => {
    const fetchSpy = vi.fn((url: string) => {
      if (url.endsWith("/batches/pending-anchor")) {
        return Promise.resolve(pendingResponse([pendingBatch]));
      }
      if (url.endsWith("/anchor-failure")) {
        return Promise.resolve(new Response("{}", { status: 201 }));
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    mocks.anchorBatchRoot.mockReturnValue(new Promise(() => {})); // never settles

    const start = Date.now();
    const anchored = await anchorOnce();
    const elapsedMs = Date.now() - start;

    expect(anchored).toBe(0);
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("records exactly one anchor per verified batch and reports the count", async () => {
    const fetchSpy = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith("/batches/pending-anchor")) {
        return Promise.resolve(pendingResponse([pendingBatch]));
      }
      if (url.endsWith("/batches/batch-1/anchor") && init?.method === "POST") {
        return Promise.resolve(new Response("{}", { status: 200 }));
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);

    mocks.anchorBatchRoot.mockResolvedValue({
      stellarTxHash: "tx1",
      stellarLedger: 10,
      network: "testnet",
      dataEntryKey: "proofchain:batch:batch-1",
      anchoredAt: new Date().toISOString(),
    });
    mocks.verifyAnchorOnLedger.mockResolvedValue({
      txFound: true,
      memoMatches: true,
      dataEntryMatches: false,
      ledger: 10,
      verified: true,
    });

    const anchored = await anchorOnce();

    expect(anchored).toBe(1);
  });
});
