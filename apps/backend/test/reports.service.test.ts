import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { verifyMerkleProof } from "@proofchain/shared";
import { BatchesService } from "../src/batches/batches.service";
import type { ReportsService } from "../src/reports/reports.service";
import {
  AnchorRecordEntity,
  BatchEntity,
  CollectionEventEntity,
  CustodyTransferEntity,
} from "../src/database/entities";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { insertEvent, seedHub, type SeededHub } from "./support/fixtures";
import { buildReportsService } from "./support/services";

/**
 * The audit artifact IS the product: everything else exists to be able to
 * generate it. Its contract with a recipient is that the root can be re-derived
 * from the event list in the document alone, without calling our API.
 */

let db: TestDatabase;
let reports: ReportsService;
let batches: BatchesService;
let seeded: SeededHub;

beforeEach(async () => {
  db ??= await createTestDatabase();
  await db.reset();
  reports = buildReportsService(db.dataSource);
  batches = new BatchesService(
    db.dataSource.getRepository(BatchEntity),
    db.dataSource.getRepository(CollectionEventEntity),
    db.dataSource.getRepository(AnchorRecordEntity),
    db.dataSource,
  );
  seeded = await seedHub(db.dataSource);
});

afterAll(async () => {
  await db?.close();
});

async function sealedBatch(weights: number[]): Promise<string> {
  const batch = await batches.create(seeded.hub.id, "PET");
  const events = [];
  for (const [index, weightKg] of weights.entries()) {
    events.push(
      await insertEvent(db.dataSource, seeded, {
        weightKg,
        capturedAt: new Date(Date.UTC(2026, 2, 1, 8 + index)),
      }),
    );
  }
  await batches.addEvents(
    batch.id,
    events.map((e) => e.id),
  );
  await batches.seal(batch.id);
  return batch.id;
}

describe("ReportsService.buildAuditReport", () => {
  it("recomputes the root from the listed events and matches the sealed value", async () => {
    const batchId = await sealedBatch([4, 6, 2.5]);

    const report = await reports.buildAuditReport(batchId);

    // Recomputed, not copied off the batch row: a report that echoed the
    // stored root would prove nothing about the events it lists.
    expect(report.proof.recomputedRoot).toBe(report.proof.merkleRoot);
    expect(report.proof.rootMatchesSealedValue).toBe(true);
    expect(report.proof.allProofsValid).toBe(true);
  });

  it("carries a proof per event that a recipient can check offline", async () => {
    const batchId = await sealedBatch([1, 2, 3, 4, 5]);
    const report = await reports.buildAuditReport(batchId);

    // The recipient's whole procedure, run here with no service involved.
    for (const event of report.events) {
      expect(verifyMerkleProof(event.leaf, event.merkleProof, report.proof.recomputedRoot!)).toBe(
        true,
      );
    }
    expect(report.events).toHaveLength(5);
  });

  it("names the hashing algorithms and the ordering the root depends on", async () => {
    const report = await reports.buildAuditReport(await sealedBatch([1]));

    // Without these three strings the root is unreproducible, and the report
    // reduces to a claim the reader has to take on trust.
    expect(report.proof.leafHashAlgorithm).toBe("sha256(0x00 || payloadHash)");
    expect(report.proof.nodeHashAlgorithm).toBe("sha256(0x01 || left || right)");
    expect(report.proof.ordering).toBe("capturedAt ASC, id ASC");
  });

  it("summarises weight per collector and in tonnes", async () => {
    const report = await reports.buildAuditReport(await sealedBatch([100, 250.5]));

    expect(report.batch.totalWeightKg).toBe(350.5);
    expect(report.batch.totalWeightTonnes).toBe(0.3505);
    expect(report.collectors).toHaveLength(1);
    expect(report.collectors[0]!.weightKg).toBe(350.5);
    expect(report.collectors[0]!.name).toBe(seeded.collector.name);
  });

  it("reports no on-chain section until the batch is anchored", async () => {
    const batchId = await sealedBatch([3]);
    expect((await reports.buildAuditReport(batchId)).onChain).toBeNull();

    await batches.recordAnchor(batchId, {
      merkleRoot: (await batches.findOne(batchId)).merkleRoot!,
      stellarTxHash: "a".repeat(64),
      stellarLedger: 4033690,
      network: "testnet",
      dataEntryKey: `proofchain:batch:${batchId}`,
      anchoredAt: "2026-03-01T12:00:00.000Z",
    });

    expect(await reports.buildAuditReport(batchId)).toMatchObject({
      onChain: { stellarTxHash: "a".repeat(64), stellarLedger: 4033690 },
    });
  });

  it("states plainly what the anchor does not prove", async () => {
    const report = await reports.buildAuditReport(await sealedBatch([1]));

    // A buyer reading "anchored on Stellar" as "the plastic was real" is the
    // misreading with the largest downside for everyone involved.
    expect(report.attestationNotes.join(" ")).toMatch(/does not.*prove the material/i);
  });

  it("404s for an unknown batch rather than 500ing a public verifier", async () => {
    await expect(
      reports.buildAuditReport("00000000-0000-0000-0000-000000000000"),
    ).rejects.toThrow(/no batch exists/);
  });
});

describe("ReportsService — reconciliation", () => {
  async function transfer(
    batchId: string,
    values: Partial<CustodyTransferEntity> & { weightInKg: number; weightOutKg: number },
  ) {
    return db.dataSource.getRepository(CustodyTransferEntity).save({
      batchId,
      fromParty: "hub",
      toParty: "processor",
      varianceKg: Number((values.weightInKg - values.weightOutKg).toFixed(3)),
      reason: null,
      transferredAt: new Date("2026-03-02T09:00:00.000Z"),
      ...values,
    } as CustodyTransferEntity);
  }

  it("reports the gap between collected and delivered weight", async () => {
    const batchId = await sealedBatch([100, 100]);
    await transfer(batchId, { weightInKg: 200, weightOutKg: 190, reason: "moisture loss" });

    const { reconciliation } = await reports.buildAuditReport(batchId);

    expect(reconciliation.collectedKg).toBe(200);
    expect(reconciliation.finalWeightOutKg).toBe(190);
    expect(reconciliation.gapKg).toBe(10);
    expect(reconciliation.gapPct).toBe(5);
  });

  it("marks an unexplained variance as unexplained", async () => {
    const batchId = await sealedBatch([100]);
    await transfer(batchId, { weightInKg: 100, weightOutKg: 80, reason: null });

    // A 20 kg gap with no stated reason is the shape of leakage or of a
    // mis-weigh, and the report must not let it pass as reconciled.
    expect((await reports.buildAuditReport(batchId)).reconciliation.explained).toBe(false);
  });

  it("leaves the gap null when nothing has been delivered yet", async () => {
    const { reconciliation } = await reports.buildAuditReport(await sealedBatch([50]));

    // Null, not zero: "no transfer recorded" and "delivered exactly what was
    // collected" are opposite findings for an auditor.
    expect(reconciliation.finalWeightOutKg).toBeNull();
    expect(reconciliation.gapKg).toBeNull();
  });
});

describe("ReportsService.buildEventCsv", () => {
  it("emits one header row and one row per event", async () => {
    const batchId = await sealedBatch([1, 2, 3]);

    const csv = await reports.buildEventCsv(batchId);
    const lines = csv.split("\r\n");

    expect(lines[0]).toContain("event_id,collector_id,collector_name");
    expect(lines).toHaveLength(4);
  });

  it("quotes a collector name containing a comma", async () => {
    const hub = await seedHub(db.dataSource, {
      collector: { name: "Otieno, Joseph" },
    });
    const batch = await batches.create(hub.hub.id, "PET");
    const event = await insertEvent(db.dataSource, hub);
    await batches.addEvents(batch.id, [event.id]);
    await batches.seal(batch.id);

    const csv = await reports.buildEventCsv(batch.id);

    // Unquoted, the name would shift every following column by one and the
    // verifier's spreadsheet would read weights out of the wrong fields.
    expect(csv).toContain('"Otieno, Joseph"');

    const [header, row] = csv.split("\r\n");
    expect(parseCsvRow(row!)).toHaveLength(header!.split(",").length);
    expect(parseCsvRow(row!)[2]).toBe("Otieno, Joseph");
  });

  it("carries the payload hash and Merkle leaf for offline checking", async () => {
    const batchId = await sealedBatch([5]);
    const report = await reports.buildAuditReport(batchId);

    const csv = await reports.buildEventCsv(batchId);

    expect(csv).toContain(report.events[0]!.payloadHash);
    expect(csv).toContain(report.events[0]!.leaf);
  });
});

/** Minimal RFC 4180 reader — enough to prove the writer's quoting is honest. */
function parseCsvRow(row: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < row.length; i += 1) {
    const char = row[i]!;
    if (inQuotes) {
      if (char === '"' && row[i + 1] === '"') {
        current += '"';
        i += 1;
      } else if (char === '"') {
        inQuotes = false;
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}
