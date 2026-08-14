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

describe("anchorOnce — failure reporting", () => {
  function spyWith(handlers: {
    pending: unknown[];
    onReport?: (body: Record<string, unknown>) => void;
  }) {
    const reports: Record<string, unknown>[] = [];
    const fetchSpy = vi.fn((url: string, init?: RequestInit) => {
      if (String(url).endsWith("/batches/pending-anchor")) {
        return Promise.resolve(pendingResponse(handlers.pending));
      }
      if (String(url).endsWith("/anchor-failure")) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        reports.push(body);
        handlers.onReport?.(body);
        return Promise.resolve(new Response("{}", { status: 201 }));
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    vi.stubGlobal("fetch", fetchSpy);
    return { fetchSpy, reports };
  }

  it("reports a submission error as failed, with the cause", async () => {
    const { reports } = spyWith({ pending: [pendingBatch] });
    mocks.anchorBatchRoot.mockRejectedValue(new Error("tx_insufficient_fee"));

    await anchorOnce();

    expect(reports).toEqual([
      { outcome: "failed", detail: expect.stringContaining("tx_insufficient_fee") },
    ]);
  });

  it("presents the worker token when reporting", async () => {
    const { fetchSpy } = spyWith({ pending: [pendingBatch] });
    mocks.anchorBatchRoot.mockRejectedValue(new Error("boom"));

    await anchorOnce();

    const [, init] = fetchSpy.mock.calls.find(([url]) =>
      String(url).endsWith("/anchor-failure"),
    )!;
    // Unauthenticated, this endpoint would let anyone park every sealed batch
    // in maximum backoff and stop anchoring silently.
    expect((init?.headers as Record<string, string>)["x-anchor-worker-token"]).toBeTruthy();
  });

  it("truncates a pathological error before sending it", async () => {
    const { reports } = spyWith({ pending: [pendingBatch] });
    mocks.anchorBatchRoot.mockRejectedValue(new Error("x".repeat(50_000)));

    await anchorOnce();

    // Trimmed here rather than rejected by the backend: losing the whole
    // report over a long stack trace would be a poor trade.
    expect(String(reports[0]!.detail).length).toBe(2_000);
  });

  it("keeps processing later batches when one fails", async () => {
    const second = { ...pendingBatch, id: "batch-2" };
    const { reports } = spyWith({ pending: [pendingBatch, second] });
    mocks.anchorBatchRoot.mockRejectedValue(new Error("horizon 504"));

    await anchorOnce();

    // One bad batch must not stall the queue behind it — including now that
    // each failure costs an extra round trip to report.
    expect(reports).toHaveLength(2);
  });

  it("does not fail the cycle when the report itself cannot be delivered", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) => {
        if (String(url).endsWith("/batches/pending-anchor")) {
          return Promise.resolve(pendingResponse([pendingBatch]));
        }
        return Promise.reject(new Error("backend unreachable"));
      }),
    );
    mocks.anchorBatchRoot.mockRejectedValue(new Error("horizon 504"));

    // Degrades to the old behaviour: the batch stays queued and is retried.
    await expect(anchorOnce()).resolves.toBe(0);
  });
});
