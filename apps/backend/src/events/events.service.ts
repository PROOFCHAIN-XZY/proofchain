import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { QueryFailedError, Repository } from "typeorm";
import {
  eventPayloadHash,
  type IntegrityVerdict,
  type WeighInPayload,
} from "@proofchain/shared";
import {
  CollectionEventEntity,
  CollectorEntity,
  DeviceEntity,
  HubEntity,
} from "../database/entities";
import { evaluateIntegrity } from "./integrity";
import { loadConfig } from "../config/configuration";

const UNIQUE_VIOLATION = "23505";

export interface IngestResult {
  eventId: string;
  payloadHash: string;
  quarantined: boolean;
  integrity: IntegrityVerdict;
  /** True when this exact signed weigh-in had already been ingested. */
  duplicate: boolean;
}

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);
  private readonly maxClockSkewSeconds = loadConfig().maxClockSkewSeconds;

  constructor(
    @InjectRepository(CollectionEventEntity)
    private readonly events: Repository<CollectionEventEntity>,
    @InjectRepository(DeviceEntity)
    private readonly devices: Repository<DeviceEntity>,
    @InjectRepository(CollectorEntity)
    private readonly collectors: Repository<CollectorEntity>,
    @InjectRepository(HubEntity)
    private readonly hubs: Repository<HubEntity>,
  ) {}

  /**
   * Ingest one signed weigh-in.
   *
   * A failing event is STORED, not rejected. Quarantined records are the raw
   * material of fraud detection and of the "% captured cleanly" pilot metric —
   * throwing them away would destroy the evidence that the system is working.
   * They simply can never enter a batch.
   */
  async ingest(payload: WeighInPayload, signature: string): Promise<IngestResult> {
    if (payload.schema !== "proofchain.weighin.v1") {
      throw new BadRequestException(`unsupported payload schema: ${payload.schema}`);
    }

    const payloadHash = eventPayloadHash(payload);
    const now = new Date();

    const [device, collector, hub, existing] = await Promise.all([
      this.devices.findOne({ where: { id: payload.deviceId } }),
      this.collectors.findOne({ where: { id: payload.collectorId } }),
      this.hubs.findOne({ where: { id: payload.hubId } }),
      this.events.findOne({ where: { payloadHash }, select: { id: true } }),
    ]);

    const integrity = evaluateIntegrity(payload, signature, {
      device: device
        ? {
            id: device.id,
            collectorId: device.collectorId,
            publicKeyBase64: device.publicKeyBase64,
            revokedAt: device.revokedAt,
          }
        : null,
      collector: collector ? { id: collector.id, active: collector.active } : null,
      hub: hub
        ? {
            id: hub.id,
            lat: hub.lat,
            lng: hub.lng,
            geofenceRadiusM: hub.geofenceRadiusM,
            minWeightKg: Number(hub.minWeightKg),
            maxWeightKg: Number(hub.maxWeightKg),
          }
        : null,
      isDuplicate: existing !== null,
      now,
      maxClockSkewSeconds: this.maxClockSkewSeconds,
    });

    // A replay is not a new fact. Report the original rather than storing a copy.
    if (existing) {
      return {
        eventId: existing.id,
        payloadHash,
        quarantined: true,
        integrity,
        duplicate: true,
      };
    }

    // Foreign keys must exist before we can persist at all.
    if (!device || !collector || !hub) {
      throw new BadRequestException({
        message: "unknown device, collector or hub",
        integrity,
      });
    }

    const quarantined = integrity.outcome === "fail";

    const entity = this.events.create({
      collectorId: payload.collectorId,
      hubId: payload.hubId,
      deviceId: payload.deviceId,
      batchId: null,
      weightKg: payload.weightKg,
      material: payload.material,
      lat: payload.lat,
      lng: payload.lng,
      capturedAt: new Date(payload.capturedAt),
      receivedAt: now,
      photoHash: payload.photoHash,
      photoUri: null,
      nonce: payload.nonce,
      signature,
      payloadHash,
      integrity,
      quarantined,
    });

    try {
      const saved = await this.events.save(entity);
      if (quarantined) {
        this.logger.warn(
          `quarantined event ${saved.id} from device ${payload.deviceId}: ` +
            integrity.findings
              .filter((f) => f.outcome === "fail")
              .map((f) => `${f.check}(${f.detail ?? ""})`)
              .join(", "),
        );
      }
      return { eventId: saved.id, payloadHash, quarantined, integrity, duplicate: false };
    } catch (error) {
      // Two devices syncing the same queued event concurrently race here; the
      // unique index on payloadHash is the authority, not the earlier read.
      if (error instanceof QueryFailedError && (error as any).code === UNIQUE_VIOLATION) {
        const winner = await this.events.findOneOrFail({
          where: { payloadHash },
          select: { id: true },
        });
        return {
          eventId: winner.id,
          payloadHash,
          quarantined: true,
          integrity,
          duplicate: true,
        };
      }
      throw error;
    }
  }

  async findOne(id: string): Promise<CollectionEventEntity> {
    const event = await this.events.findOne({ where: { id } });
    if (!event) throw new NotFoundException(`event ${id} not found`);
    return event;
  }

  async list(filter: {
    hubId?: string;
    collectorId?: string;
    batched?: boolean;
    quarantined?: boolean;
    limit?: number;
  }): Promise<CollectionEventEntity[]> {
    const qb = this.events.createQueryBuilder("e").orderBy("e.capturedAt", "DESC");

    if (filter.hubId) qb.andWhere("e.hubId = :hubId", { hubId: filter.hubId });
    if (filter.collectorId) {
      qb.andWhere("e.collectorId = :collectorId", { collectorId: filter.collectorId });
    }
    if (filter.quarantined !== undefined) {
      qb.andWhere("e.quarantined = :quarantined", { quarantined: filter.quarantined });
    }
    if (filter.batched === true) qb.andWhere("e.batchId IS NOT NULL");
    if (filter.batched === false) qb.andWhere("e.batchId IS NULL");

    return qb.take(Math.min(filter.limit ?? 100, 500)).getMany();
  }

  /** Events eligible to join a batch: clean, unbatched, at this hub. */
  async eligibleForBatch(hubId: string, material: string): Promise<CollectionEventEntity[]> {
    return this.events.find({
      where: { hubId, batchId: null as never, quarantined: false, material: material as never },
      order: { capturedAt: "ASC" },
    });
  }
}
