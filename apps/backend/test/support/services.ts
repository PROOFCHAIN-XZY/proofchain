import type { DataSource } from "typeorm";
import { EventsService } from "../../src/events/events.service";
import type {
  LedgerConfirmation,
  LedgerVerificationService,
} from "../../src/ledger/ledger-verification.service";
import { AnchorAttemptsService } from "../../src/batches/anchor-attempts.service";
import { ReportsService } from "../../src/reports/reports.service";
import {
  AnchorAttemptEntity,
  AnchorRecordEntity,
  CollectionEventEntity,
  CollectorEntity,
  CustodyTransferEntity,
  DeviceEntity,
  HubEntity,
  BatchEntity,
} from "../../src/database/entities";

/**
 * Constructs the services under test directly from repositories, rather than
 * booting a Nest testing module.
 *
 * The DI container adds nothing these suites are asserting on — every one of
 * them is about SQL and domain rules — and skipping it keeps the tests fast
 * enough to run per-example rather than per-suite.
 */

/**
 * loadConfig() fails fast on a missing DATABASE_URL, which is the right
 * behaviour at boot and merely in the way here: these tests never open a socket.
 * Set before constructing any service that reads config at construction time.
 */
export function stubRequiredEnv(overrides: Record<string, string> = {}): void {
  process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:5433/proofchain_test";
  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }
}

export function buildEventsService(dataSource: DataSource): EventsService {
  stubRequiredEnv();
  return new EventsService(
    dataSource.getRepository(CollectionEventEntity),
    dataSource.getRepository(DeviceEntity),
    dataSource.getRepository(CollectorEntity),
    dataSource.getRepository(HubEntity),
  );
}

export function buildReportsService(dataSource: DataSource): ReportsService {
  stubRequiredEnv();
  return new ReportsService(
    dataSource.getRepository(BatchEntity),
    dataSource.getRepository(CollectionEventEntity),
    dataSource.getRepository(CustodyTransferEntity),
    dataSource.getRepository(CollectorEntity),
    dataSource.getRepository(HubEntity),
    dataSource.getRepository(AnchorRecordEntity),
    stubLedgerVerification(),
  );
}

/**
 * A ledger verifier that never consults Horizon.
 *
 * The batch and report suites are about Merkle structure and SQL, and should
 * not gain a network dependency to exercise either. Suites that are actually
 * about ledger read-back drive LedgerVerificationService directly.
 *
 * Defaults to the unchecked answer rather than a confirming one, so a test that
 * cares about confirmation has to say so.
 */
export function stubLedgerVerification(
  confirmation: Partial<LedgerConfirmation> = {},
): LedgerVerificationService {
  const answer: LedgerConfirmation = {
    checked: false,
    rootMatchesLedger: null,
    memoMatches: false,
    dataEntryMatches: false,
    ledger: null,
    checkedAt: new Date().toISOString(),
    detail: "ledger read-back stubbed out in tests",
    ...confirmation,
  };
  return { verify: async () => answer } as unknown as LedgerVerificationService;
}

/**
 * Attempt recording backed by the test database.
 *
 * Not a stub: the batch suite's backoff assertions depend on real rows, and a
 * fake would make the queue-filtering tests assert on the fake's arithmetic
 * rather than on the service's.
 */
export function buildAnchorAttemptsService(dataSource: DataSource): AnchorAttemptsService {
  stubRequiredEnv();
  return new AnchorAttemptsService(dataSource.getRepository(AnchorAttemptEntity), dataSource);
}
