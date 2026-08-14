import { Injectable, Logger } from "@nestjs/common";
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

  constructor(baseUrl?: string, timeoutMs?: number) {
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
      },
    };
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
