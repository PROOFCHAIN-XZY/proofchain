import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HorizonClient } from "../src/ledger/horizon.client";
import { stubRequiredEnv } from "./support/services";

/**
 * The client's whole job is to answer "what does the public ledger say" and to
 * keep "it says no" separate from "it did not answer". These tests are mostly
 * about that distinction.
 */

const HORIZON = "https://horizon-testnet.example";
const ROOT_HEX = "3fb0f496f209507098e6439c646a60d6a576de856a28afbb4f44598b77dc512f";
const ROOT_B64 = Buffer.from(ROOT_HEX, "hex").toString("base64");

let client: HorizonClient;

/** A trimmed copy of a real Horizon transaction record. */
function txRecord(overrides: Record<string, unknown> = {}) {
  return {
    hash: "a".repeat(64),
    ledger: 4033690,
    successful: true,
    memo_type: "hash",
    memo: ROOT_B64,
    ...overrides,
  };
}

function respondWith(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    ),
  );
}

beforeEach(() => {
  stubRequiredEnv();
  client = new HorizonClient(HORIZON, 500);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("HorizonClient.transaction", () => {
  it("reads the memo, ledger and success flag off the record", async () => {
    respondWith(txRecord());

    const result = await client.transaction("a".repeat(64));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ledger).toBe(4033690);
    expect(result.value.successful).toBe(true);
    expect(result.value.memoType).toBe("hash");
    // Left base64: decoding is the verifier's job, not the transport's.
    expect(result.value.memo).toBe(ROOT_B64);
  });

  it("accepts a ledger sequence serialised as a string", async () => {
    respondWith(txRecord({ ledger: "4033690" }));

    const result = await client.transaction("a".repeat(64));

    expect(result.ok && result.value.ledger).toBe(4033690);
  });

  it("reports a transaction with no memo rather than inventing one", async () => {
    respondWith(txRecord({ memo_type: "none", memo: undefined }));

    const result = await client.transaction("a".repeat(64));

    expect(result.ok && result.value.memo).toBeNull();
    expect(result.ok && result.value.memoType).toBe("none");
  });

  it("percent-encodes the hash into the path", async () => {
    respondWith(txRecord());

    await client.transaction("../accounts/GABC");

    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    // A hash is caller-supplied; unencoded it could walk to another endpoint.
    expect(String(url)).toBe(`${HORIZON}/transactions/..%2Faccounts%2FGABC`);
  });
});

describe("HorizonClient.accountData", () => {
  it("returns the manageData entries as stored", async () => {
    respondWith({ data: { "proofchain:batch:abc": ROOT_B64 } });

    const result = await client.accountData("GABC");

    expect(result.ok && result.value["proofchain:batch:abc"]).toBe(ROOT_B64);
  });

  it("returns an empty map for an account with no data entries", async () => {
    respondWith({ data: {} });

    const result = await client.accountData("GABC");

    expect(result.ok && result.value).toEqual({});
  });
});

describe("HorizonClient — failure modes", () => {
  it("reports a 404 as not_found, not as unavailable", async () => {
    respondWith({ status: 404, title: "Resource Missing" }, 404);

    const result = await client.transaction("b".repeat(64));

    expect(result.ok).toBe(false);
    // The distinction is the whole contract: not_found means the ledger does
    // not have this transaction, which is a verification failure. unavailable
    // means we could not ask, which is not a finding about the batch at all.
    expect(!result.ok && result.reason).toBe("not_found");
  });

  it("reports a 5xx as unavailable", async () => {
    respondWith({ status: 503 }, 503);

    const result = await client.transaction("b".repeat(64));

    expect(!result.ok && result.reason).toBe("unavailable");
  });

  it("reports a rate-limited read as unavailable", async () => {
    respondWith({ status: 429 }, 429);

    expect((await client.transaction("b".repeat(64))).ok).toBe(false);
  });

  it("treats a non-JSON body as unavailable rather than throwing", async () => {
    respondWith("<html>gateway error</html>");

    const result = await client.transaction("b".repeat(64));

    // A proxy returning an HTML error page must not become a 500 on a public
    // verification endpoint.
    expect(!result.ok && result.reason).toBe("unavailable");
  });

  it("gives up on a hanging Horizon within the configured timeout", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );

    const started = Date.now();
    const result = await new HorizonClient(HORIZON, 100).transaction("b".repeat(64));

    expect(!result.ok && result.reason).toBe("unavailable");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("reports a network-level failure as unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    expect((await client.accountData("GABC")).ok).toBe(false);
  });
});
