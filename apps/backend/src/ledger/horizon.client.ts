import { Injectable, Logger, Optional } from "@nestjs/common";
import { loadConfig } from "../config/configuration";

/**
 * A read-only Horizon client.
 *
 * Deliberately `fetch` over the REST API rather than @stellar/stellar-sdk: the
 * backend only ever *reads* two documents here, and the SDK is a large
 * dependency whose value is transaction building and signing — neither of which
 * belongs in a process that holds no Stellar key. The anchor worker keeps the
 * SDK because it writes.
 *
 * Every method answers "what does the public ledger say", so every failure is
 * reported as absence rather than thrown. A caller distinguishing "Horizon says
 * no" from "Horizon did not answer" is the entire point of this class, and an
 * exception collapses that distinction into a 500.
 */

/** The subset of a Horizon transaction record an anchor check needs. */
export interface HorizonTransaction {
  hash: string;
  ledger: number;
  successful: boolean;
  /** "hash" for the MEMO_HASH anchors are written with. */
  memoType: string;
  /** base64 as Horizon returns it; decoding is the verifier's job. */
  memo: string | null;
  /**
   * The account that submitted the anchor. Read off the ledger rather than
   * stored by us, so the manageData corroboration is looked up on the account
   * the network says signed the transaction, not on one we assert it was.
   */
  sourceAccount: string | null;
}

/** Why a read produced nothing — the distinction a verifier depends on. */
export type HorizonFailure = "not_found" | "unavailable";

export type HorizonResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: HorizonFailure; detail: string };

@Injectable()
export class HorizonClient {
  private readonly logger = new Logger(HorizonClient.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  /**
   * The overrides exist for tests, which point the client at a stub server.
   * `@Optional()` is what stops Nest trying to *inject* a String and a Number
   * for them at boot — without it the container fails to construct this
   * provider at all, and the whole app fails to start.
   */
  constructor(@Optional() baseUrl?: string, @Optional() timeoutMs?: number) {
    const config = loadConfig();
    this.baseUrl = (baseUrl ?? config.stellarHorizonUrl).replace(/\/+$/, "");
    this.timeoutMs = timeoutMs ?? config.horizonTimeoutMs;
  }

  /** The transaction record for an anchor, or why it could not be read. */
  async transaction(hash: string): Promise<HorizonResult<HorizonTransaction>> {
    const result = await this.getJson(`/transactions/${encodeURIComponent(hash)}`);
    if (!result.ok) return result;

    const body = result.value;
    return {
      ok: true,
      value: {
        hash: String(body.hash ?? hash),
        // Horizon serialises ledger sequence as a number here, but the field
        // has been a string in older versions; Number() covers both.
        ledger: Number(body.ledger ?? body.ledger_attr ?? 0),
        successful: body.successful === true,
        memoType: String(body.memo_type ?? "none"),
        memo: typeof body.memo === "string" ? body.memo : null,
        sourceAccount: typeof body.source_account === "string" ? body.source_account : null,
      },
    };
  }

  /**
   * The account's manageData entries, base64 as stored.
   *
   * The anchor writes the root twice — a memo on the transaction and a data
   * entry on the account — so that either alone still proves the anchor. The
   * data entry is the weaker of the two (a later batch on the same account
   * overwrites it), which is exactly why it is read separately and never
   * required.
   */
  async accountData(accountId: string): Promise<HorizonResult<Record<string, string>>> {
    const result = await this.getJson(`/accounts/${encodeURIComponent(accountId)}`);
    if (!result.ok) return result;

    const data = result.value.data;
    if (data === null || typeof data !== "object") {
      return { ok: true, value: {} };
    }

    const entries: Record<string, string> = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (typeof value === "string") entries[key] = value;
    }
    return { ok: true, value: entries };
  }

  private async getJson(path: string): Promise<HorizonResult<Record<string, unknown>>> {
    const url = `${this.baseUrl}${path}`;

    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      // A 404 is a fact about the ledger — this transaction is not on it — and
      // must not be smeared together with Horizon being unreachable.
      if (response.status === 404) {
        return { ok: false, reason: "not_found", detail: `${url} returned 404` };
      }
      if (!response.ok) {
        return { ok: false, reason: "unavailable", detail: `${url} returned ${response.status}` };
      }

      return { ok: true, value: (await response.json()) as Record<string, unknown> };
    } catch (error) {
      // Timeouts, DNS failures, TLS errors and malformed JSON all land here.
      // None of them says anything about the ledger's contents.
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`horizon read failed for ${url}: ${detail}`);
      return { ok: false, reason: "unavailable", detail };
    }
  }
}
