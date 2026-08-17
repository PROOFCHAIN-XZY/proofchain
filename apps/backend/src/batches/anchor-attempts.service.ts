import { Injectable, Logger } from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { DataSource, In, Repository } from "typeorm";
import type { AnchorAttemptOutcome } from "@proofchain/shared";
import { AnchorAttemptEntity } from "../database/entities";

/**
 * The record of what anchoring actually did.
 *
 * Before this, a failed anchor produced a log line and nothing else. The
 * operational consequence was not that failures were unlogged — it was that
 * nothing downstream could see them: the dashboard could not show a stuck
 * batch, the pending queue could not slow down, and "has this been retried
 * twice or four hundred times" was unanswerable without grepping a container's
 * stdout.
 */

export interface RecordedAttempt {
  outcome: AnchorAttemptOutcome;
  detail?: string | null;
  stellarTxHash?: string | null;
}

/** What the pending-anchor queue and the operator views need per batch. */
export interface AttemptSummary {
  batchId: string;
  attempts: number;
  failures: number;
  lastOutcome: AnchorAttemptOutcome | null;
  lastAttemptAt: Date | null;
  lastDetail: string | null;
}

/**
 * Long enough to keep a stored error readable, short enough that a pathological
 * upstream cannot write unbounded rows. Stack traces from the Stellar SDK run
 * to several kilobytes and the useful part is always at the front.
 */
const MAX_DETAIL_LENGTH = 2_000;

@Injectable()
export class AnchorAttemptsService {
  private readonly logger = new Logger(AnchorAttemptsService.name);

  constructor(
    @InjectRepository(AnchorAttemptEntity)
    private readonly attempts: Repository<AnchorAttemptEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Append an attempt.
   *
   * The number is assigned from inside a transaction that locks nothing, which
   * is deliberate: two workers racing could produce two attempts numbered 3,
   * and that is a strictly better failure than blocking the write. The number
   * is for operators reading a history, not a key anything depends on.
   */
  async record(batchId: string, input: RecordedAttempt): Promise<AnchorAttemptEntity> {
    return this.dataSource.transaction(async (manager) => {
      const previous = await manager.count(AnchorAttemptEntity, { where: { batchId } });

      const attempt = manager.create(AnchorAttemptEntity, {
        batchId,
        attemptNumber: previous + 1,
        outcome: input.outcome,
        detail: input.detail ? input.detail.slice(0, MAX_DETAIL_LENGTH) : null,
        stellarTxHash: input.stellarTxHash ?? null,
        occurredAt: new Date(),
      });

      const saved = await manager.save(AnchorAttemptEntity, attempt);

      if (input.outcome !== "succeeded") {
        this.logger.warn(
          `anchor attempt ${saved.attemptNumber} for batch ${batchId} ended ${input.outcome}: ${input.detail ?? "no detail"}`,
        );
      }

      return saved;
    });
  }

  /** Newest first — an operator wants the current failure, not the first one. */
  async historyFor(batchId: string, limit = 20): Promise<AnchorAttemptEntity[]> {
    return this.attempts.find({
      where: { batchId },
      order: { occurredAt: "DESC", attemptNumber: "DESC" },
      take: limit,
    });
  }

  /**
   * Summaries for a set of batches in one query.
   *
   * Called with the whole pending queue on every worker poll, so it must not
   * become one query per batch.
   */
  async summariesFor(batchIds: string[]): Promise<Map<string, AttemptSummary>> {
    const summaries = new Map<string, AttemptSummary>();
    if (batchIds.length === 0) return summaries;

    const rows = await this.attempts.find({
      where: { batchId: In(batchIds) },
      order: { occurredAt: "ASC" },
    });

    for (const row of rows) {
      const existing = summaries.get(row.batchId) ?? {
        batchId: row.batchId,
        attempts: 0,
        failures: 0,
        lastOutcome: null,
        lastAttemptAt: null,
        lastDetail: null,
      };

      existing.attempts += 1;
      if (row.outcome !== "succeeded") existing.failures += 1;
      // Rows are ordered oldest first, so the last write wins and "last" is
      // genuinely the most recent.
      existing.lastOutcome = row.outcome;
      existing.lastAttemptAt = row.occurredAt;
      existing.lastDetail = row.detail;

      summaries.set(row.batchId, existing);
    }

    return summaries;
  }
}
