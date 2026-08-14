import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HorizonClient, HorizonResult, HorizonTransaction } from "../src/ledger/horizon.client";
import { LedgerVerificationService } from "../src/ledger/ledger-verification.service";
import { stubRequiredEnv } from "./support/services";

/**
 * The service answers one question — does the public ledger carry this batch's
 * sealed root — with three possible answers, and the third (we could not ask)
 * is the one that must never be mistaken for the second.
 */

const ROOT = "3fb0f496f209507098e6439c646a60d6a576de856a28afbb4f44598b77dc512f";
const OTHER_ROOT = "f".repeat(64);
const TX = "a".repeat(64);
const ACCOUNT = "GDEMO";
const KEY = "proofchain:batch:0f1e";

const b64 = (hex: string) => Buffer.from(hex, "hex").toString("base64");

function tx(overrides: Partial<HorizonTransaction> = {}): HorizonResult<HorizonTransaction> {
  return {
    ok: true,
    value: {
      hash: TX,
      ledger: 4033690,
      successful: true,
      memoType: "hash",
      memo: b64(ROOT),
      sourceAccount: ACCOUNT,
      ...overrides,
    },
  };
}

function serviceWith(
  transaction: HorizonResult<HorizonTransaction>,
  accountData: HorizonResult<Record<string, string>> = { ok: true, value: {} },
): LedgerVerificationService {
  stubRequiredEnv();
  const horizon = {
    transaction: vi.fn(async () => transaction),
    accountData: vi.fn(async () => accountData),
  } as unknown as HorizonClient;
  return new LedgerVerificationService(horizon);
}

const anchor = { stellarTxHash: TX, merkleRoot: ROOT, dataEntryKey: KEY };

beforeEach(() => {
  stubRequiredEnv();
});

describe("LedgerVerificationService — agreement", () => {
  it("confirms a root carried by the transaction memo", async () => {
    const result = await serviceWith(tx()).verify(anchor);

    expect(result.checked).toBe(true);
    expect(result.rootMatchesLedger).toBe(true);
    expect(result.memoMatches).toBe(true);
    expect(result.ledger).toBe(4033690);
  });

  it("confirms a root carried only by the account data entry", async () => {
    // The realistic degraded case: the memo is intact on chain but a later
    // batch has not overwritten this key, or vice versa. One reference is enough.
    const result = await serviceWith(tx({ memo: null, memoType: "none" }), {
      ok: true,
      value: { [KEY]: b64(ROOT) },
    }).verify(anchor);

    expect(result.rootMatchesLedger).toBe(true);
    expect(result.memoMatches).toBe(false);
    expect(result.dataEntryMatches).toBe(true);
  });

  it("reads the data entry on the account the ledger names as source", async () => {
    const horizon = {
      transaction: vi.fn(async () => tx()),
      accountData: vi.fn(async () => ({ ok: true as const, value: {} })),
    } as unknown as HorizonClient;

    await new LedgerVerificationService(horizon).verify(anchor);

    // Not on an account we stored: the corroboration is worthless if we get to
    // choose which account it is read from.
    expect(horizon.accountData).toHaveBeenCalledWith(ACCOUNT);
  });
});

describe("LedgerVerificationService — disagreement", () => {
  it("reports false when the memo carries a different root", async () => {
    const result = await serviceWith(tx({ memo: b64(OTHER_ROOT) })).verify(anchor);

    // A real, successful transaction that attests to something else. Either
    // the wrong tx was recorded against this batch or the write-back was
    // forged, and a buyer must see false rather than null.
    expect(result.checked).toBe(true);
    expect(result.rootMatchesLedger).toBe(false);
  });

  it("reports false when the ledger has no such transaction", async () => {
    const result = await serviceWith({
      ok: false,
      reason: "not_found",
      detail: "404",
    }).verify(anchor);

    expect(result.checked).toBe(true);
    expect(result.rootMatchesLedger).toBe(false);
    expect(result.detail).toMatch(/no transaction/);
  });

  it("reports false for a transaction that did not succeed", async () => {
    const result = await serviceWith(tx({ successful: false })).verify(anchor);

    expect(result.rootMatchesLedger).toBe(false);
  });

  it("does not accept a non-hash memo that happens to contain the root", async () => {
    // MEMO_TEXT is caller-controlled free text and is not the commitment the
    // anchor makes; only MEMO_HASH is.
    const result = await serviceWith(tx({ memoType: "text", memo: b64(ROOT) })).verify(anchor);

    expect(result.memoMatches).toBe(false);
  });

  it("ignores a data entry stored under a different batch's key", async () => {
    const result = await serviceWith(tx({ memo: null, memoType: "none" }), {
      ok: true,
      value: { "proofchain:batch:someone-else": b64(ROOT) },
    }).verify(anchor);

    expect(result.dataEntryMatches).toBe(false);
    expect(result.rootMatchesLedger).toBe(false);
  });
});

describe("LedgerVerificationService — unavailable", () => {
  it("reports null rather than false when Horizon cannot be reached", async () => {
    const result = await serviceWith({
      ok: false,
      reason: "unavailable",
      detail: "timed out",
    }).verify(anchor);

    // The distinction the whole tri-state exists for: an outage must not read
    // as the ledger contradicting the batch.
    expect(result.checked).toBe(false);
    expect(result.rootMatchesLedger).toBeNull();
    expect(result.detail).toMatch(/could not reach Horizon/);
  });

  it("still confirms via the memo when only the account read fails", async () => {
    const result = await serviceWith(tx(), {
      ok: false,
      reason: "unavailable",
      detail: "timed out",
    }).verify(anchor);

    // The corroborating call is optional; losing it must not downgrade an
    // anchor the transaction itself already proves.
    expect(result.rootMatchesLedger).toBe(true);
    expect(result.dataEntryMatches).toBe(false);
  });
});

describe("LedgerVerificationService — caching", () => {
  function countingService(result: HorizonResult<HorizonTransaction>) {
    stubRequiredEnv();
    const transaction = vi.fn(async () => result);
    const horizon = {
      transaction,
      accountData: vi.fn(async () => ({ ok: true as const, value: {} })),
    } as unknown as HorizonClient;
    return { service: new LedgerVerificationService(horizon), transaction };
  }

  it("reads Horizon once for a confirmed anchor", async () => {
    const { service, transaction } = countingService(tx());

    await service.verify(anchor);
    await service.verify(anchor);
    await service.verify(anchor);

    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("re-reads after an unavailable result instead of caching the outage", async () => {
    const { service, transaction } = countingService({
      ok: false,
      reason: "unavailable",
      detail: "timed out",
    });

    await service.verify(anchor);
    await service.verify(anchor);

    // Caching a null would leave the batch permanently unverifiable for the
    // life of the process, over a blip that lasted one second.
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("re-reads after a mismatch, which may be Horizon lagging a fresh anchor", async () => {
    const { service, transaction } = countingService({
      ok: false,
      reason: "not_found",
      detail: "404",
    });

    await service.verify(anchor);
    await service.verify(anchor);

    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("does not answer one root's question with another root's result", async () => {
    const { service, transaction } = countingService(tx());

    const first = await service.verify(anchor);
    const second = await service.verify({ ...anchor, merkleRoot: OTHER_ROOT });

    // Same transaction, different claim: the cache key has to carry both or a
    // forged root would inherit a genuine root's confirmation.
    expect(first.rootMatchesLedger).toBe(true);
    expect(second.rootMatchesLedger).toBe(false);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("makes one Horizon call for simultaneous first-time requests", async () => {
    const { service, transaction } = countingService(tx());

    const results = await Promise.all([
      service.verify(anchor),
      service.verify(anchor),
      service.verify(anchor),
    ]);

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.rootMatchesLedger === true)).toBe(true);
  });
});
