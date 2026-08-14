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
