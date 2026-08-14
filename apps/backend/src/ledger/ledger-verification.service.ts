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

    const dataEntryMatches = await this.dataEntryCarriesRoot(
      tx.value.sourceAccount,
      anchor.dataEntryKey,
      anchor.merkleRoot,
    );

    // Either reference is sufficient. Requiring both would make an anchor
    // stop verifying the moment a later batch overwrote the data entry, which
    // happens routinely on a single-account deployment.
    const rootMatchesLedger = memoMatches || dataEntryMatches;

    if (!rootMatchesLedger) {
      // Loud: the transaction exists and succeeded, but carries a different
      // root. That is either the wrong tx recorded against this batch or a
      // forged write-back, and both need a human.
      this.logger.error(
        `ledger disagreement for tx ${anchor.stellarTxHash}: expected root ${anchor.merkleRoot}`,
      );
    }

    return {
      checked: true,
      rootMatchesLedger,
      memoMatches,
      dataEntryMatches,
      ledger: tx.value.ledger || null,
      checkedAt: new Date().toISOString(),
      detail: rootMatchesLedger
        ? `ledger confirms the sealed root (memo=${memoMatches}, dataEntry=${dataEntryMatches})`
        : `transaction ${anchor.stellarTxHash} does not carry the sealed root`,
    };
  }

  /**
   * Corroboration only — never required.
   *
   * A failure here is silent because it is not a finding: the account may have
   * moved on to a later batch's entry, and Horizon may simply be unreachable
   * for this second call after answering the first.
   */
  private async dataEntryCarriesRoot(
    sourceAccount: string | null,
    dataEntryKey: string,
    merkleRoot: string,
  ): Promise<boolean> {
    if (!sourceAccount) return false;

    const account = await this.horizon.accountData(sourceAccount);
    if (!account.ok) return false;

    const value = account.value[dataEntryKey];
    return typeof value === "string" && base64ToHex(value) === merkleRoot;
  }
}
