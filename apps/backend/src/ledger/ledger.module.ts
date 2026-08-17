import { Module } from "@nestjs/common";
import { HorizonClient } from "./horizon.client";
import { LedgerVerificationService } from "./ledger-verification.service";

/**
 * Ledger read-back, kept in its own module so both the batch verification
 * endpoint and the audit report can depend on one shared instance.
 *
 * Sharing the instance is not incidental: the confirmation cache lives on the
 * service, so a per-consumer copy would multiply Horizon traffic by the number
 * of consumers and defeat it.
 */
@Module({
  providers: [HorizonClient, LedgerVerificationService],
  exports: [LedgerVerificationService],
})
export class LedgerModule {}
