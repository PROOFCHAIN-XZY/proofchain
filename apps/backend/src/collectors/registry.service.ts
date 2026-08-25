import { ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { publicKeyFromBase64 } from "@proofchain/shared";
import { CollectorEntity, DeviceEntity, HubEntity } from "../database/entities";
import type { CreateCollectorDto, CreateHubDto, EnrolDeviceDto } from "../common/dto";

/** What a capture device is told about a hub. */
export interface HubDirectoryEntry {
  id: string;
  code: string;
  name: string;
  /** Sanity bounds for a single weigh-in here, so the device can pre-check. */
  minWeightKg: number;
  maxWeightKg: number;
}

/** Collectors, their devices, and the hubs they work at. */
@Injectable()
export class RegistryService {
  private readonly logger = new Logger(RegistryService.name);

  constructor(
    @InjectRepository(CollectorEntity) private readonly collectors: Repository<CollectorEntity>,
    @InjectRepository(DeviceEntity) private readonly devices: Repository<DeviceEntity>,
    @InjectRepository(HubEntity) private readonly hubs: Repository<HubEntity>,
  ) {}

  listCollectors() {
    return this.collectors.find({ order: { createdAt: "DESC" } });
  }

  async createCollector(dto: CreateCollectorDto) {
    const existing = await this.collectors.findOne({ where: { phone: dto.phone } });
    if (existing) throw new ConflictException(`a collector with phone ${dto.phone} already exists`);

    return this.collectors.save(
      this.collectors.create({
        name: dto.name,
        phone: dto.phone,
        cooperativeId: dto.cooperativeId ?? null,
        kycLevel: dto.kycLevel ?? "none",
        active: true,
      }),
    );
  }

  async enrolDevice(dto: EnrolDeviceDto) {
    const collector = await this.collectors.findOne({ where: { id: dto.collectorId } });
    if (!collector) throw new NotFoundException(`collector ${dto.collectorId} not found`);

    // Reject a key we cannot actually verify signatures with, at enrolment time
    // rather than silently failing every weigh-in later.
    try {
      publicKeyFromBase64(dto.publicKeyBase64);
    } catch (error) {
      throw new ConflictException(`invalid ed25519 public key: ${(error as Error).message}`);
    }

    const clash = await this.devices.findOne({ where: { publicKeyBase64: dto.publicKeyBase64 } });
    if (clash) throw new ConflictException("this device key is already enrolled");

    return this.devices.save(
      this.devices.create({
        collectorId: dto.collectorId,
        label: dto.label,
        publicKeyBase64: dto.publicKeyBase64,
        revokedAt: null,
      }),
    );
  }

  async revokeDevice(id: string) {
    const device = await this.devices.findOne({ where: { id } });
    if (!device) throw new NotFoundException(`device ${id} not found`);
    if (device.revokedAt) return device;

    device.revokedAt = new Date();
    return this.devices.save(device);
  }

  listDevices(collectorId?: string) {
    return this.devices.find({
      where: collectorId ? { collectorId } : {},
      order: { enrolledAt: "DESC" },
    });
  }

  listHubs() {
    return this.hubs.find({ order: { code: "ASC" } });
  }

  /**
   * The hub list a capture device needs, and nothing more.
   *
   * Separate from listHubs() because it is public: a field phone holds no
   * credentials — the device signature is its only one — but it still has to
   * name the hub it is capturing for. Same reasoning as the material catalogue.
   *
   * Trimmed deliberately, but the weight bounds are part of it. They were held
   * back as operational configuration once, and that cost collectors weigh-ins:
   * a device that does not know the ceiling cannot stop a collector signing a
   * weight the hub will refuse, so the refusal arrived at sync time with the
   * material long gone. Withholding them never protected anything either — the
   * ingest response already tells an unauthenticated device the exact figure
   * ("300 kg above hub maximum 200 kg"). Publishing them up front turns a
   * rejection into a correction the collector can still make.
   */
  async hubDirectory(): Promise<HubDirectoryEntry[]> {
    const hubs = await this.hubs.find({ order: { code: "ASC" } });

    // The entity's numeric transformer has already narrowed these; Number() is
    // belt and braces for the one thing this endpoint must never emit — a
    // string where a field phone expects something it can compare and format.
    return hubs.map((hub) => ({
      id: hub.id,
      code: hub.code,
      name: hub.name,
      minWeightKg: Number(hub.minWeightKg),
      maxWeightKg: Number(hub.maxWeightKg),
    }));
  }

  async createHub(dto: CreateHubDto) {
    const existing = await this.hubs.findOne({ where: { code: dto.code } });
    if (existing) throw new ConflictException(`hub ${dto.code} already exists`);

    const hub = this.hubs.create({
      code: dto.code,
      name: dto.name,
      minWeightKg: dto.minWeightKg ?? 0.1,
      maxWeightKg: dto.maxWeightKg ?? 10_000,
    });

    return this.hubs.save(hub);
  }

}
