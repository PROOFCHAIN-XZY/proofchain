import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectDataSource, InjectRepository } from "@nestjs/typeorm";
import { DataSource, In, IsNull, Repository } from "typeorm";
import {
  hashLeaf,
  merkleProof,
  merkleRootHex,
  verifyMerkleProof,
  type BatchStatus,
  type EventVerification,
  type AnchorAttemptOutcome,
  type MaterialType,
  type StellarNetwork,
} from "@proofchain/shared";
import {
  AnchorAttemptEntity,
  AnchorRecordEntity,
  BatchEntity,
  CollectionEventEntity,
} from "../database/entities";
import {
  LedgerVerificationService,
  type LedgerConfirmation,
} from "../ledger/ledger-verification.service";
import { AnchorAttemptsService } from "./anchor-attempts.service";
import { isDueForRetry, isStuck, nextAttemptAt } from "./anchor-backoff";

/**
 * Batch lifecycle: open -> sealed -> processed -> sold.
 *
 * Sealing is the hinge of the entire product. Before it, a batch is a mutable
 * working set; after it, its membership and Merkle root are frozen and a root
 * goes to the ledger. Everything here exists to make that transition
 * irreversible and reproducible by a third party.
 */

const LEGAL_TRANSITIONS: Record<BatchStatus, BatchStatus[]> = {
  open: ["sealed"],
  sealed: ["processed"],
  processed: ["sold"],
  sold: [],
};

export interface AwaitingAnchor {
  batchId: string;
  sealedAt: string | null;
  totalWeightKg: number;
  eventCount: number;
  failedAttempts: number;
  lastOutcome: AnchorAttemptOutcome | null;
  lastAttemptAt: string | null;
  lastDetail: string | null;
  /** null when the batch is due now. */
  nextAttemptAt: string | null;
  /** Repeated failure past the point where a transient cause is plausible. */
  stuck: boolean;
}

export interface AnchorHealth {
  checkedAt: string;
  awaitingAnchor: number;
  stuck: number;
  unanchoredWeightKg: number;
  batches: AwaitingAnchor[];
}

export interface BatchLedgerStatus {
  batchId: string;
  anchored: boolean;
  merkleRoot: string | null;
  onChain: {
    network: StellarNetwork;
    txHash: string;
    ledger: number;
    dataEntryKey: string;
    explorerUrl: string;
  } | null;
  /** null only when there is no anchor to check. */
  confirmation: LedgerConfirmation | null;
}

export interface PendingAnchorBatch {
  id: string;
  merkleRoot: string;
  totalWeightKg: number;
  eventCount: number;
  /** How many times anchoring this batch has already been tried and failed. */
  failedAttempts: number;
  /** Why the last attempt failed, so the worker's log names the real cause. */
  lastFailureDetail: string | null;
}

@Injectable()
export class BatchesService {
  constructor(
    @InjectRepository(BatchEntity)
    private readonly batches: Repository<BatchEntity>,
    @InjectRepository(CollectionEventEntity)
    private readonly events: Repository<CollectionEventEntity>,
    @InjectRepository(AnchorRecordEntity)
    private readonly anchors: Repository<AnchorRecordEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly ledger: LedgerVerificationService,
    private readonly attempts: AnchorAttemptsService,
  ) {}

  /**
   * Events are ordered by capture time then id. Any deterministic total order
   * works, but it must never change: the Merkle root — and therefore every proof
   * already handed to a buyer — depends on it.
   */
  private orderedEvents(batchId: string): Promise<CollectionEventEntity[]> {
    return this.events.find({
      where: { batchId },
      order: { capturedAt: "ASC", id: "ASC" },
    });
  }

  private static leavesOf(events: CollectionEventEntity[]): string[] {
    return events.map((e) => hashLeaf(e.payloadHash));
  }

  async create(hubId: string, material: MaterialType): Promise<BatchEntity> {
    const batch = this.batches.create({
      hubId,
      material,
      status: "open",
      totalWeightKg: 0,
      eventCount: 0,
      merkleRoot: null,
      sealedAt: null,
    });
    return this.batches.save(batch);
  }

  async findOne(id: string): Promise<BatchEntity> {
    const batch = await this.batches.findOne({ where: { id }, relations: { anchor: true } });
    if (!batch) throw new NotFoundException(`batch ${id} not found`);
    return batch;
  }

  async list(status?: BatchStatus): Promise<BatchEntity[]> {
    return this.batches.find({
      where: status ? { status } : {},
      relations: { anchor: true },
      order: { createdAt: "DESC" },
    });
  }

  /**
   * Pull unassigned, non-quarantined events at the hub into an open batch.
   * Quarantined events are never eligible — a failed integrity check must not be
   * able to reach a saleable credit.
   */
  async addEvents(batchId: string, eventIds: string[]): Promise<BatchEntity> {
    return this.dataSource.transaction(async (manager) => {
      const batch = await manager.findOne(BatchEntity, {
        where: { id: batchId },
        lock: { mode: "pessimistic_write" },
      });
      if (!batch) throw new NotFoundException(`batch ${batchId} not found`);
      if (batch.status !== "open") {
        throw new ConflictException(`batch ${batchId} is ${batch.status}, not open`);
      }

      const candidates = await manager.find(CollectionEventEntity, {
        where: { id: In(eventIds), batchId: IsNull(), quarantined: false, hubId: batch.hubId },
      });

      const found = new Set(candidates.map((c) => c.id));
      const rejected = eventIds.filter((id) => !found.has(id));
      if (rejected.length > 0) {
        throw new BadRequestException(
          `events not eligible for this batch (already batched, quarantined, or at another hub): ${rejected.join(", ")}`,
        );
      }

      const mismatched = candidates.filter((c) => c.material !== batch.material);
      if (mismatched.length > 0) {
        throw new BadRequestException(
          `events do not match batch material ${batch.material}: ${mismatched.map((m) => m.id).join(", ")}`,
        );
      }

      await manager.update(CollectionEventEntity, { id: In([...found]) }, { batchId });

      const totals = await this.recomputeTotals(manager, batchId);
      await manager.update(BatchEntity, { id: batchId }, totals);

      return manager.findOneOrFail(BatchEntity, { where: { id: batchId } });
    });
  }

  async removeEvent(batchId: string, eventId: string): Promise<BatchEntity> {
    return this.dataSource.transaction(async (manager) => {
      const batch = await manager.findOne(BatchEntity, {
        where: { id: batchId },
        lock: { mode: "pessimistic_write" },
      });
      if (!batch) throw new NotFoundException(`batch ${batchId} not found`);
      if (batch.status !== "open") {
        throw new ConflictException(
          `batch ${batchId} is ${batch.status}; sealed membership cannot change`,
        );
      }

      const result = await manager.update(
        CollectionEventEntity,
        { id: eventId, batchId },
        { batchId: null },
      );
      if (result.affected === 0) {
        throw new NotFoundException(`event ${eventId} is not in batch ${batchId}`);
      }

      const totals = await this.recomputeTotals(manager, batchId);
      await manager.update(BatchEntity, { id: batchId }, totals);
      return manager.findOneOrFail(BatchEntity, { where: { id: batchId } });
    });
  }

  private async recomputeTotals(
    manager: DataSource["manager"],
    batchId: string,
  ): Promise<{ totalWeightKg: number; eventCount: number }> {
    const rows = await manager.find(CollectionEventEntity, {
      where: { batchId },
      select: { id: true, weightKg: true },
    });
    const totalWeightKg = Number(rows.reduce((sum, r) => sum + Number(r.weightKg), 0).toFixed(3));
    return { totalWeightKg, eventCount: rows.length };
  }

  /**
   * Freeze membership and compute the root. Runs inside a transaction with the
   * batch row locked, so two concurrent seals cannot produce two different roots
   * for the same batch.
   */
  async seal(batchId: string): Promise<BatchEntity> {
    return this.dataSource.transaction(async (manager) => {
      const batch = await manager.findOne(BatchEntity, {
        where: { id: batchId },
        lock: { mode: "pessimistic_write" },
      });
      if (!batch) throw new NotFoundException(`batch ${batchId} not found`);
      if (batch.status !== "open") {
        throw new ConflictException(`batch ${batchId} is already ${batch.status}`);
      }

      const events = await manager.find(CollectionEventEntity, {
        where: { batchId },
        order: { capturedAt: "ASC", id: "ASC" },
      });

      if (events.length === 0) {
        throw new BadRequestException("cannot seal an empty batch");
      }
      const quarantined = events.filter((e) => e.quarantined);
      if (quarantined.length > 0) {
        // Defence in depth: addEvents already excludes these.
        throw new ConflictException(
          `batch contains quarantined events: ${quarantined.map((e) => e.id).join(", ")}`,
        );
      }

      const merkleRoot = merkleRootHex(BatchesService.leavesOf(events));
      const totalWeightKg = Number(
        events.reduce((sum, e) => sum + Number(e.weightKg), 0).toFixed(3),
      );

      await manager.update(
        BatchEntity,
        { id: batchId },
        {
          status: "sealed",
          sealedAt: new Date(),
          merkleRoot,
          totalWeightKg,
          eventCount: events.length,
        },
      );

      return manager.findOneOrFail(BatchEntity, { where: { id: batchId } });
    });
  }

  async advanceStatus(batchId: string, to: BatchStatus): Promise<BatchEntity> {
    const batch = await this.findOne(batchId);

    const allowed = LEGAL_TRANSITIONS[batch.status];
    if (!allowed.includes(to)) {
      throw new ConflictException(
        `illegal transition ${batch.status} -> ${to} (allowed: ${allowed.join(", ") || "none"})`,
      );
    }

    // Checked after the transition table, not before, so that moving backwards
    // to "sealed" is still reported as the illegal transition it is. What is
    // left here is the one case the table calls legal: open -> sealed.
    //
    // That step is legal in the lifecycle but cannot be taken by setting a
    // column. Sealing means computing and freezing the root; arriving at
    // "sealed" without one leaves a batch that cannot be added to, cannot be
    // removed from, cannot be anchored (pendingAnchor requires a root) and
    // cannot be sealed either, because seal() only accepts an open batch. The
    // batch and every event in it would be stuck there permanently.
    if (to === "sealed") {
      throw new ConflictException(
        "a batch is sealed by POST /batches/:id/seal, which computes and freezes its Merkle root",
      );
    }

    if (to === "processed" && !batch.merkleRoot) {
      throw new ConflictException("batch must be sealed before it can be processed");
    }
    await this.batches.update({ id: batchId }, { status: to });
    return this.findOne(batchId);
  }

  /**
   * Sealed batches with no AnchorRecord yet, minus those still in backoff.
   *
   * Filtering here rather than in the worker is deliberate: this query is the
   * single source of truth about what needs anchoring, and a second worker — or
   * a restarted one — would otherwise not know a batch had just failed. Holding
   * the schedule next to the attempt history keeps one answer for everyone.
   */
  async pendingAnchor(now = new Date()): Promise<PendingAnchorBatch[]> {
    const rows = await this.batches
      .createQueryBuilder("b")
      .leftJoin(AnchorRecordEntity, "a", "a.batchId = b.id")
      .where("b.status = :status", { status: "sealed" })
      .andWhere("a.id IS NULL")
      .andWhere("b.merkleRoot IS NOT NULL")
      .orderBy("b.sealedAt", "ASC")
      .select(["b.id", "b.merkleRoot", "b.totalWeightKg", "b.eventCount"])
      .getMany();

    const summaries = await this.attempts.summariesFor(rows.map((b) => b.id));

    return rows
      .filter((b) => isDueForRetry(summaries.get(b.id), now))
      .map((b) => {
        const summary = summaries.get(b.id);
        return {
          id: b.id,
          merkleRoot: b.merkleRoot!,
          totalWeightKg: Number(b.totalWeightKg),
          eventCount: b.eventCount,
          failedAttempts: summary?.failures ?? 0,
          lastFailureDetail: summary?.lastDetail ?? null,
        };
      });
  }

  /**
   * What anchoring is currently doing, for an operator rather than a worker.
   *
   * The question it answers is the one nobody could previously ask without
   * reading container logs: is anchoring working, and if not, which batches are
   * stuck and why. Unanchored batches only — an anchored batch's history is on
   * the batch itself.
   */
  async anchorHealth(now = new Date()): Promise<AnchorHealth> {
    const sealed = await this.batches
      .createQueryBuilder("b")
      .leftJoin(AnchorRecordEntity, "a", "a.batchId = b.id")
      .where("b.status != :open", { open: "open" })
      .andWhere("a.id IS NULL")
      .andWhere("b.merkleRoot IS NOT NULL")
      .orderBy("b.sealedAt", "ASC")
      .select(["b.id", "b.merkleRoot", "b.sealedAt", "b.totalWeightKg", "b.eventCount"])
      .getMany();

    const summaries = await this.attempts.summariesFor(sealed.map((b) => b.id));

    const batches: AwaitingAnchor[] = sealed.map((b) => {
      const summary = summaries.get(b.id);
      return {
        batchId: b.id,
        sealedAt: b.sealedAt?.toISOString() ?? null,
        totalWeightKg: Number(b.totalWeightKg),
        eventCount: b.eventCount,
        failedAttempts: summary?.failures ?? 0,
        lastOutcome: summary?.lastOutcome ?? null,
        lastAttemptAt: summary?.lastAttemptAt?.toISOString() ?? null,
        lastDetail: summary?.lastDetail ?? null,
        nextAttemptAt: nextAttemptAt(summary)?.toISOString() ?? null,
        stuck: isStuck(summary),
      };
    });

    return {
      checkedAt: now.toISOString(),
      awaitingAnchor: batches.length,
      // The single number an operator or an alert should watch.
      stuck: batches.filter((b) => b.stuck).length,
      // Weight that is sealed and unanchored is weight that cannot be sold yet.
      unanchoredWeightKg: Number(batches.reduce((sum, b) => sum + b.totalWeightKg, 0).toFixed(3)),
      batches,
    };
  }

  /**
   * Record the on-chain result. Rejects a root that disagrees with the sealed
   * batch: an anchor pointing at the wrong data is worse than no anchor at all.
   */
  async recordAnchor(
    batchId: string,
    input: {
      merkleRoot: string;
      stellarTxHash: string;
      stellarLedger: number;
      network: StellarNetwork;
      dataEntryKey: string;
      anchoredAt: string;
    },
  ): Promise<AnchorRecordEntity> {
    const batch = await this.findOne(batchId);

    if (batch.status === "open" || !batch.merkleRoot) {
      throw new ConflictException("cannot anchor a batch that has not been sealed");
    }
    if (batch.merkleRoot !== input.merkleRoot) {
      throw new ConflictException(
        `anchored root ${input.merkleRoot} does not match sealed root ${batch.merkleRoot}`,
      );
    }

    const existing = await this.anchors.findOne({ where: { batchId } });
    if (existing) {
      // Idempotent for a worker retry of the same transaction; loud otherwise.
      // No attempt is recorded here: the successful one was already written
      // when this anchor first landed, and a retry of the write-back is not a
      // second attempt at anchoring.
      if (existing.stellarTxHash === input.stellarTxHash) return existing;
      throw new ConflictException(
        `batch ${batchId} is already anchored by tx ${existing.stellarTxHash}`,
      );
    }

    const anchor = this.anchors.create({
      batchId,
      merkleRoot: input.merkleRoot,
      stellarTxHash: input.stellarTxHash,
      stellarLedger: input.stellarLedger,
      network: input.network,
      dataEntryKey: input.dataEntryKey,
      anchoredAt: new Date(input.anchoredAt),
    });
    const saved = await this.anchors.save(anchor);

    // Closes the history. Without this a batch that failed five times and then
    // anchored would read, forever, as a batch that failed five times.
    await this.attempts.record(batchId, {
      outcome: "succeeded",
      stellarTxHash: input.stellarTxHash,
      detail: `anchored in ledger ${input.stellarLedger}`,
    });

    return saved;
  }

  /**
   * Record an attempt that did not produce an anchor.
   *
   * Called by the worker, which is the only party that knows why a submission
   * failed. It cannot be inferred here: from the backend's side a failed anchor
   * and a worker that was never started look identical — the batch simply stays
   * in the queue, which is precisely the ambiguity this removes.
   */
  async recordAnchorFailure(
    batchId: string,
    input: { outcome: "failed" | "unverified"; detail?: string; stellarTxHash?: string },
  ): Promise<AnchorAttemptEntity> {
    const batch = await this.findOne(batchId);

    if (batch.status === "open" || !batch.merkleRoot) {
      throw new ConflictException("cannot record an anchor attempt for an unsealed batch");
    }

    const anchored = await this.anchors.findOne({ where: { batchId } });
    if (anchored) {
      // A failure reported against an already-anchored batch is a stale worker
      // or a duplicate report. Recording it would make a healthy batch look
      // broken on the operator view.
      throw new ConflictException(
        `batch ${batchId} is already anchored by tx ${anchored.stellarTxHash}`,
      );
    }

    return this.attempts.record(batchId, input);
  }

  /**
   * The verification an auditor runs: recompute the leaf, rebuild the proof from
   * stored events, and check it against the root that went on-chain.
   */
  async verifyEvent(batchId: string, eventId: string): Promise<EventVerification> {
    const batch = await this.findOne(batchId);
    if (!batch.merkleRoot) {
      throw new ConflictException(`batch ${batchId} has not been sealed`);
    }

    const events = await this.orderedEvents(batchId);
    const index = events.findIndex((e) => e.id === eventId);
    if (index < 0) throw new NotFoundException(`event ${eventId} is not in batch ${batchId}`);

    const leaves = BatchesService.leavesOf(events);
    const leaf = leaves[index]!;
    const proof = merkleProof(leaves, index);
    const anchor = await this.anchors.findOne({ where: { batchId } });

    // Read back from Horizon rather than reported from our own row. Until this
    // existed, the endpoint proved a Merkle path against a root held in our
    // database and told the caller it was "on chain" — true, but unchecked by
    // anyone who was not already trusting us.
    const confirmation = anchor
      ? await this.ledger.verify({
          stellarTxHash: anchor.stellarTxHash,
          merkleRoot: anchor.merkleRoot,
          dataEntryKey: anchor.dataEntryKey,
        })
      : null;

    return {
      eventId,
      batchId,
      leaf,
      proof,
      merkleRoot: batch.merkleRoot,
      proofValid: verifyMerkleProof(leaf, proof, batch.merkleRoot),
      onChain: anchor
        ? {
            network: anchor.network,
            txHash: anchor.stellarTxHash,
            // Horizon's ledger sequence when it answered, ours when it did not.
            ledger: confirmation?.ledger ?? Number(anchor.stellarLedger),
            explorerUrl: explorerUrl(anchor.network, anchor.stellarTxHash),
            rootMatchesLedger: confirmation?.rootMatchesLedger ?? null,
          }
        : null,
    };
  }

  /**
   * Ask the ledger about a batch's anchor directly.
   *
   * Separate from verifyEvent because the two answer different questions and
   * fail for different reasons: "is this weigh-in in the batch" is a Merkle
   * question answerable from our own data, while "did this root reach the
   * ledger" depends on Horizon being up. An auditor checking a hundred events
   * should not make a hundred Horizon reads to learn one fact about the batch.
   */
  async ledgerStatus(batchId: string): Promise<BatchLedgerStatus> {
    const batch = await this.findOne(batchId);
    const anchor = await this.anchors.findOne({ where: { batchId } });

    if (!anchor) {
      return {
        batchId,
        anchored: false,
        merkleRoot: batch.merkleRoot,
        onChain: null,
        confirmation: null,
      };
    }

    const confirmation = await this.ledger.verify({
      stellarTxHash: anchor.stellarTxHash,
      merkleRoot: anchor.merkleRoot,
      dataEntryKey: anchor.dataEntryKey,
    });

    return {
      batchId,
      anchored: true,
      merkleRoot: batch.merkleRoot,
      onChain: {
        network: anchor.network,
        txHash: anchor.stellarTxHash,
        ledger: confirmation.ledger ?? Number(anchor.stellarLedger),
        dataEntryKey: anchor.dataEntryKey,
        explorerUrl: explorerUrl(anchor.network, anchor.stellarTxHash),
      },
      confirmation,
    };
  }

  /**
   * Everything recorded about anchoring this batch, newest first.
   *
   * Survives the anchor: the health view is a work queue and drops a batch as
   * soon as it succeeds, but "this batch took nine attempts" stays relevant to
   * anyone reviewing it afterwards.
   */
  async anchorAttemptsFor(batchId: string): Promise<AnchorAttemptEntity[]> {
    await this.findOne(batchId);
    return this.attempts.historyFor(batchId);
  }

  async eventsOf(batchId: string): Promise<CollectionEventEntity[]> {
    await this.findOne(batchId);
    return this.orderedEvents(batchId);
  }
}

export function explorerUrl(network: StellarNetwork, txHash: string): string {
  return `https://stellar.expert/explorer/${network === "public" ? "public" : "testnet"}/tx/${txHash}`;
}
