import { Injectable, Logger } from "@nestjs/common";
import { HorizonClient } from "./horizon.client";

/**
 * Re-reads an anchor off the public ledger and compares it to the root we hold.
 *
 * The anchor worker already does this once, at write time. This exists because
 * that check leaves no durable, queryable answer behind: every later reader —
 * the verify endpoint, the audit report, a buyer refreshing a page a year on —
 * was falling back to comparing our database against itself.
 */

/**
 * Tri-state on purpose. `null` is not a hedge: it is the difference between
 * "the ledger contradicts this batch" (a serious finding about ProofChain) and
 * "Horizon did not answer" (a fact about the network right now). Collapsing the
 * second into `false` would have a Horizon outage read as evidence of fraud.
 */
export interface LedgerConfirmation {
  /** True when the ledger was successfully consulted, whatever it said. */
  checked: boolean;
  /** null when unchecked; otherwise whether the ledger carries this root. */
  rootMatchesLedger: boolean | null;
  /** The MEMO_HASH on the anchoring transaction equals the root. */
  memoMatches: boolean;
  /** The account's manageData entry for this batch equals the root. */
  dataEntryMatches: boolean;
  /** Ledger sequence the anchor was included in, per Horizon. */
  ledger: number | null;
  checkedAt: string;
  /** Human-readable reason, for the unchecked and mismatching cases. */
  detail: string;
}

export interface AnchorToVerify {
  stellarTxHash: string;
  merkleRoot: string;
  dataEntryKey: string;
}

function unchecked(detail: string): LedgerConfirmation {
  return {
    checked: false,
    rootMatchesLedger: null,
    memoMatches: false,
    dataEntryMatches: false,
    ledger: null,
    checkedAt: new Date().toISOString(),
    detail,
  };
}

/** Horizon hands back base64; the sealed root is lowercase hex. */
function base64ToHex(value: string): string {
  return Buffer.from(value, "base64").toString("hex");
}

@Injectable()
export class LedgerVerificationService {
  private readonly logger = new Logger(LedgerVerificationService.name);

  constructor(private readonly horizon: HorizonClient) {}

  async verify(anchor: AnchorToVerify): Promise<LedgerConfirmation> {
    const tx = await this.horizon.transaction(anchor.stellarTxHash);

    if (!tx.ok) {
      // not_found is a genuine finding — the ledger has no such transaction —
      // but it is still reported as a mismatch rather than as unchecked.
      if (tx.reason === "not_found") {
        return {
          ...unchecked(`Horizon has no transaction ${anchor.stellarTxHash}`),
          checked: true,
          rootMatchesLedger: false,
        };
      }
      return unchecked(`could not reach Horizon: ${tx.detail}`);
    }

    if (!tx.value.successful) {
      return {
        ...unchecked(`transaction ${anchor.stellarTxHash} did not succeed on the ledger`),
        checked: true,
        rootMatchesLedger: false,
        ledger: tx.value.ledger || null,
      };
    }

    const memoMatches =
      tx.value.memoType === "hash" &&
      tx.value.memo !== null &&
      base64ToHex(tx.value.memo) === anchor.merkleRoot;

    const confirmation: LedgerConfirmation = {
      checked: true,
      rootMatchesLedger: memoMatches,
      memoMatches,
      dataEntryMatches: false,
      ledger: tx.value.ledger || null,
      checkedAt: new Date().toISOString(),
      detail: memoMatches
        ? `memo on ${anchor.stellarTxHash} matches the sealed root`
        : `memo on ${anchor.stellarTxHash} does not carry the sealed root`,
    };

    if (!memoMatches) {
      this.logger.error(
        `ledger disagreement for tx ${anchor.stellarTxHash}: expected root ${anchor.merkleRoot}`,
      );
    }

    return confirmation;
  }
}
