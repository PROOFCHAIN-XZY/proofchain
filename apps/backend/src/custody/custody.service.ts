import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { BatchEntity, CustodyTransferEntity } from "../database/entities";
import type { CreateCustodyTransferDto } from "../common/dto";

/**
 * Chain of custody with weight-in / weight-out reconciliation.
 *
 * The reconciliation gap is one of the pilot's go/no-go metrics: an unexplained
 * difference between what was collected and what was processed is exactly what
 * a verifier will challenge. So variance is stored, and a non-zero variance
 * without a stated reason is refused at write time rather than discovered later.
 */
@Injectable()
export class CustodyService {
  constructor(
    @InjectRepository(CustodyTransferEntity)
    private readonly transfers: Repository<CustodyTransferEntity>,
    @InjectRepository(BatchEntity)
    private readonly batches: Repository<BatchEntity>,
  ) {}

  async list(batchId: string) {
    return this.transfers.find({ where: { batchId }, order: { transferredAt: "ASC" } });
  }

  async create(batchId: string, dto: CreateCustodyTransferDto) {
    const batch = await this.batches.findOne({ where: { id: batchId } });
    if (!batch) throw new NotFoundException(`batch ${batchId} not found`);

    if (dto.weightOutKg > dto.weightInKg) {
      throw new BadRequestException(
        "weight out cannot exceed weight in; material does not appear in transit",
      );
    }

    const varianceKg = Number((dto.weightInKg - dto.weightOutKg).toFixed(3));
    if (varianceKg !== 0 && !dto.reason?.trim()) {
      throw new BadRequestException(
        `a variance of ${varianceKg} kg must carry a stated reason (moisture, contamination, rejects)`,
      );
    }

    return this.transfers.save(
      this.transfers.create({
        batchId,
        fromParty: dto.fromParty,
        toParty: dto.toParty,
        weightInKg: dto.weightInKg,
        weightOutKg: dto.weightOutKg,
        varianceKg,
        reason: dto.reason?.trim() || null,
        transferredAt: new Date(dto.transferredAt),
      }),
    );
  }
}
