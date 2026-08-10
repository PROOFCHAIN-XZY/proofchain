import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { publicKeyFromBase64 } from "@proofchain/shared";
import { CollectorEntity, DeviceEntity, HubEntity } from "../database/entities";
import type { CreateCollectorDto, CreateHubDto, EnrolDeviceDto } from "../common/dto";

/** Collectors, their devices, and the hubs they work at. */
@Injectable()
export class RegistryService {
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
        homeLat: dto.homeLat ?? null,
        homeLng: dto.homeLng ?? null,
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

  async createHub(dto: CreateHubDto) {
    const existing = await this.hubs.findOne({ where: { code: dto.code } });
    if (existing) throw new ConflictException(`hub ${dto.code} already exists`);

    return this.hubs.save(
      this.hubs.create({
        code: dto.code,
        name: dto.name,
        lat: dto.lat,
        lng: dto.lng,
        geofenceRadiusM: dto.geofenceRadiusM ?? 250,
        minWeightKg: dto.minWeightKg ?? 0.1,
        maxWeightKg: dto.maxWeightKg ?? 500,
      }),
    );
  }
}
