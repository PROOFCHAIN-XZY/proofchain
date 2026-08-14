import { Injectable, InternalServerErrorException, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  hashLeaf,
  merkleProof,
  merkleRootHex,
  verifyMerkleProof,
  type MerkleProofStep,
} from "@proofchain/shared";
import {
  AnchorRecordEntity,
  BatchEntity,
  CollectionEventEntity,
  CollectorEntity,
  CustodyTransferEntity,
  HubEntity,
} from "../database/entities";
import { explorerUrl } from "../batches/batches.service";
import { LedgerVerificationService } from "../ledger/ledger-verification.service";

/**
 * The audit artifact — the document a PRO, verifier or credit buyer accepts as
 * evidence. Per the project plan this IS the product spec; the rest of the
 * system exists to be able to generate it.
 *
 * Deliberately self-contained: a recipient can re-derive the Merkle root from
 * the event list in this file alone, then compare it against the Stellar
 * transaction, without calling our API or trusting our word.
 */

export interface AuditReportEvent {
  eventId: string;
  collectorId: string;
  collectorName: string;
  weightKg: number;
  material: string;
  lat: number;
  lng: number;
  capturedAt: string;
  receivedAt: string;
  photoHash: string;
  payloadHash: string;
  leaf: string;
  merkleProof: MerkleProofStep[];
  integrityOutcome: string;
  integrityFindings: { check: string; outcome: string; detail?: string }[];
}

export interface AuditReport {
  reportVersion: "proofchain.audit.v1";
  generatedAt: string;
  batch: {
    id: string;
    status: string;
    material: string;
    totalWeightKg: number;
    totalWeightTonnes: number;
    eventCount: number;
    sealedAt: string | null;
    createdAt: string;
  };
  hub: { id: string; code: string; name: string; lat: number; lng: number };
  collectors: { id: string; name: string; kycLevel: string; eventCount: number; weightKg: number }[];
  chainOfCustody: {
    id: string;
    fromParty: string;
    toParty: string;
    weightInKg: number;
    weightOutKg: number;
    varianceKg: number;
    variancePct: number | null;
    reason: string | null;
    transferredAt: string;
  }[];
  reconciliation: {
    collectedKg: number;
    finalWeightOutKg: number | null;
    gapKg: number | null;
    gapPct: number | null;
    explained: boolean;
  };
  proof: {
    merkleRoot: string | null;
    /** Recomputed here from the events listed below, not read from the batch row. */
    recomputedRoot: string | null;
    rootMatchesSealedValue: boolean;
    allProofsValid: boolean;
    leafHashAlgorithm: "sha256(0x00 || payloadHash)";
    nodeHashAlgorithm: "sha256(0x01 || left || right)";
    ordering: "capturedAt ASC, id ASC";
  };
  onChain: {
    network: string;
    stellarTxHash: string;
    stellarLedger: number;
    dataEntryKey: string;
    anchoredAt: string;
    explorerUrl: string;
    /**
     * What the ledger said when we last asked, rather than what our database
     * remembers writing. The report's other proof fields are all recomputed
     * from data in the document; this is the one claim that cannot be, so it
     * carries its own freshness and its own tri-state.
     *
     * null means we could not reach Horizon — not that the anchor failed.
     */
    ledgerConfirmation: {
      rootMatchesLedger: boolean | null;
      memoMatches: boolean;
      dataEntryMatches: boolean;
      checkedAt: string;
      detail: string;
    };
  } | null;
  events: AuditReportEvent[];
  /**
   * Stated plainly so nobody mistakes anchoring for proof of the physical fact.
   */
  attestationNotes: string[];
}

@Injectable()
export class ReportsService {
  constructor(
    @InjectRepository(BatchEntity) private readonly batches: Repository<BatchEntity>,
    @InjectRepository(CollectionEventEntity)
    private readonly events: Repository<CollectionEventEntity>,
    @InjectRepository(CustodyTransferEntity)
    private readonly custody: Repository<CustodyTransferEntity>,
    @InjectRepository(CollectorEntity)
    private readonly collectors: Repository<CollectorEntity>,
    @InjectRepository(HubEntity) private readonly hubs: Repository<HubEntity>,
    @InjectRepository(AnchorRecordEntity)
    private readonly anchors: Repository<AnchorRecordEntity>,
    private readonly ledger: LedgerVerificationService,
  ) {}

  async buildAuditReport(batchId: string): Promise<AuditReport> {
    // Deliberately not findOneOrFail: TypeORM's EntityNotFoundError is not an
    // HttpException, so Nest renders it as a 500. On a public verification
    // endpoint that is actively misleading — a verifier checking an unknown id
    // would be told our service is broken rather than that no such batch exists.
    const batch = await this.batches.findOne({ where: { id: batchId } });
    if (!batch) throw new NotFoundException(`no batch exists with id ${batchId}`);

    // A batch referencing a missing hub is a genuine internal inconsistency, so
    // 500 is the honest answer here — but say why, rather than leaking an ORM error.
    const hub = await this.hubs.findOne({ where: { id: batch.hubId } });
    if (!hub) {
      throw new InternalServerErrorException(
        `batch ${batchId} references hub ${batch.hubId}, which does not exist`,
      );
    }

    const events = await this.events.find({
      where: { batchId },
      order: { capturedAt: "ASC", id: "ASC" },
    });

    const [transfers, anchor] = await Promise.all([
      this.custody.find({ where: { batchId }, order: { transferredAt: "ASC" } }),
      this.anchors.findOne({ where: { batchId } }),
    ]);

    // Asked at render time, not read from our own row. A report is often the
    // only artifact a buyer keeps, and the whole document is worth less if its
    // one external claim is the one thing nobody rechecked.
    const confirmation = anchor
      ? await this.ledger.verify({
          stellarTxHash: anchor.stellarTxHash,
          merkleRoot: anchor.merkleRoot,
          dataEntryKey: anchor.dataEntryKey,
        })
      : null;

    const collectorIds = [...new Set(events.map((e) => e.collectorId))];
    const collectorRows = collectorIds.length
      ? await this.collectors.findByIds(collectorIds)
      : [];
    const collectorById = new Map(collectorRows.map((c) => [c.id, c]));

    const leaves = events.map((e) => hashLeaf(e.payloadHash));
    const recomputedRoot = leaves.length > 0 ? merkleRootHex(leaves) : null;

    const reportEvents: AuditReportEvent[] = events.map((e, index) => {
      const proof = leaves.length > 0 ? merkleProof(leaves, index) : [];
      return {
        eventId: e.id,
        collectorId: e.collectorId,
        collectorName: collectorById.get(e.collectorId)?.name ?? "(unknown)",
        weightKg: Number(e.weightKg),
        material: e.material,
        lat: e.lat,
        lng: e.lng,
        capturedAt: e.capturedAt.toISOString(),
        receivedAt: e.receivedAt.toISOString(),
        photoHash: e.photoHash,
        payloadHash: e.payloadHash,
        leaf: leaves[index]!,
        merkleProof: proof,
        integrityOutcome: e.integrity?.outcome ?? "unknown",
        integrityFindings: e.integrity?.findings ?? [],
      };
    });

    const allProofsValid =
      recomputedRoot !== null &&
      reportEvents.every((e) => verifyMerkleProof(e.leaf, e.merkleProof, recomputedRoot));

    const collectedKg = Number(
      events.reduce((sum, e) => sum + Number(e.weightKg), 0).toFixed(3),
    );
    const lastTransfer = transfers.at(-1) ?? null;
    const finalWeightOutKg = lastTransfer ? Number(lastTransfer.weightOutKg) : null;
    const gapKg =
      finalWeightOutKg === null ? null : Number((collectedKg - finalWeightOutKg).toFixed(3));
    const gapPct =
      gapKg === null || collectedKg === 0 ? null : Number(((gapKg / collectedKg) * 100).toFixed(2));

    const perCollector = collectorIds.map((id) => {
      const own = events.filter((e) => e.collectorId === id);
      const c = collectorById.get(id);
      return {
        id,
        name: c?.name ?? "(unknown)",
        kycLevel: c?.kycLevel ?? "none",
        eventCount: own.length,
        weightKg: Number(own.reduce((s, e) => s + Number(e.weightKg), 0).toFixed(3)),
      };
    });

    return {
      reportVersion: "proofchain.audit.v1",
      generatedAt: new Date().toISOString(),
      batch: {
        id: batch.id,
        status: batch.status,
        material: batch.material,
        totalWeightKg: Number(batch.totalWeightKg),
        totalWeightTonnes: Number((Number(batch.totalWeightKg) / 1000).toFixed(6)),
        eventCount: batch.eventCount,
        sealedAt: batch.sealedAt?.toISOString() ?? null,
        createdAt: batch.createdAt.toISOString(),
      },
      hub: { id: hub.id, code: hub.code, name: hub.name, lat: hub.lat, lng: hub.lng },
      collectors: perCollector,
      chainOfCustody: transfers.map((t) => {
        const inKg = Number(t.weightInKg);
        return {
          id: t.id,
          fromParty: t.fromParty,
          toParty: t.toParty,
          weightInKg: inKg,
          weightOutKg: Number(t.weightOutKg),
          varianceKg: Number(t.varianceKg),
          variancePct: inKg === 0 ? null : Number(((Number(t.varianceKg) / inKg) * 100).toFixed(2)),
          reason: t.reason,
          transferredAt: t.transferredAt.toISOString(),
        };
      }),
      reconciliation: {
        collectedKg,
        finalWeightOutKg,
        gapKg,
        gapPct,
        explained: transfers.every((t) => Number(t.varianceKg) === 0 || Boolean(t.reason)),
      },
      proof: {
        merkleRoot: batch.merkleRoot,
        recomputedRoot,
        rootMatchesSealedValue:
          batch.merkleRoot !== null && recomputedRoot !== null && batch.merkleRoot === recomputedRoot,
        allProofsValid,
        leafHashAlgorithm: "sha256(0x00 || payloadHash)",
        nodeHashAlgorithm: "sha256(0x01 || left || right)",
        ordering: "capturedAt ASC, id ASC",
      },
      onChain: anchor
        ? {
            network: anchor.network,
            stellarTxHash: anchor.stellarTxHash,
            stellarLedger: Number(anchor.stellarLedger),
            dataEntryKey: anchor.dataEntryKey,
            anchoredAt: anchor.anchoredAt.toISOString(),
            explorerUrl: explorerUrl(anchor.network, anchor.stellarTxHash),
            ledgerConfirmation: {
              rootMatchesLedger: confirmation?.rootMatchesLedger ?? null,
              memoMatches: confirmation?.memoMatches ?? false,
              dataEntryMatches: confirmation?.dataEntryMatches ?? false,
              checkedAt: confirmation?.checkedAt ?? new Date().toISOString(),
              detail: confirmation?.detail ?? "ledger not consulted",
            },
          }
        : null,
      events: reportEvents,
      attestationNotes: [
        "The Stellar anchor proves these records existed unaltered at the anchored ledger time. It does not, by itself, prove the material weighed was real or additional.",
        "Source-level assurance comes from device signatures, hub geofencing, photo evidence and duplicate detection, recorded per event above.",
        "Baseline and additionality figures must be completed against the selected Verra Plastic Waste Reduction Standard track before submission.",
      ],
    };
  }

  /** Flat CSV of the event log — what a verifier will open in a spreadsheet. */
  async buildEventCsv(batchId: string): Promise<string> {
    const report = await this.buildAuditReport(batchId);

    const header = [
      "event_id",
      "collector_id",
      "collector_name",
      "captured_at",
      "received_at",
      "material",
      "weight_kg",
      "lat",
      "lng",
      "photo_sha256",
      "payload_sha256",
      "merkle_leaf",
      "integrity",
    ];

    const rows = report.events.map((e) =>
      [
        e.eventId,
        e.collectorId,
        e.collectorName,
        e.capturedAt,
        e.receivedAt,
        e.material,
        e.weightKg.toFixed(3),
        e.lat.toFixed(6),
        e.lng.toFixed(6),
        e.photoHash,
        e.payloadHash,
        e.leaf,
        e.integrityOutcome,
      ].map(csvCell),
    );

    return [header.join(","), ...rows.map((r) => r.join(","))].join("\r\n");
  }
}

/** RFC 4180 quoting. Collector names are free text and will contain commas. */
function csvCell(value: string): string {
  const s = String(value ?? "");
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
