import { ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { publicKeyFromBase64 } from "@proofchain/shared";
import { CollectorEntity, DeviceEntity, HubEntity } from "../database/entities";
import type { CreateCollectorDto, CreateHubDto, EnrolDeviceDto } from "../common/dto";
import { NominatimClient, type GeocodeResult } from "./nominatim.client";

/** What a capture device is told about a hub. */
export interface HubDirectoryEntry {
  id: string;
  code: string;
  name: string;
  lat: number;
  lng: number;
  geofenceRadiusM: number;
}

/** Collectors, their devices, and the hubs they work at. */
@Injectable()
export class RegistryService {
  private readonly logger = new Logger(RegistryService.name);

  constructor(
    @InjectRepository(CollectorEntity) private readonly collectors: Repository<CollectorEntity>,
    @InjectRepository(DeviceEntity) private readonly devices: Repository<DeviceEntity>,
    @InjectRepository(HubEntity) private readonly hubs: Repository<HubEntity>,
    private readonly geocoder: NominatimClient,
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

  /**
   * The hub list a capture device needs, and nothing more.
   *
   * Separate from listHubs() because it is public: a field phone holds no
   * credentials — the device signature is its only one, and it deliberately does
   * not extend to reading configuration — but it cannot judge whether a fix
   * places the collector inside a geofence without knowing where the hubs are.
   * Same reasoning as the material catalogue.
   *
   * Trimmed deliberately. Coordinates and fences are already on every enrolled
   * phone and printed in audit reports, so publishing them is not new exposure;
   * the weight bounds are operational configuration and stay behind auth.
   */
  async hubDirectory(): Promise<HubDirectoryEntry[]> {
    const hubs = await this.hubs.find({ order: { code: "ASC" } });

    return hubs.map((hub) => ({
      id: hub.id,
      code: hub.code,
      name: hub.name,
      lat: hub.lat,
      lng: hub.lng,
      geofenceRadiusM: hub.geofenceRadiusM,
    }));
  }

  async createHub(dto: CreateHubDto) {
    const existing = await this.hubs.findOne({ where: { code: dto.code } });
    if (existing) throw new ConflictException(`hub ${dto.code} already exists`);

    const hub = this.hubs.create({
      code: dto.code,
      name: dto.name,
      lat: dto.lat,
      lng: dto.lng,
      geofenceRadiusM: dto.geofenceRadiusM ?? 250,
      minWeightKg: dto.minWeightKg ?? 0.1,
      maxWeightKg: dto.maxWeightKg ?? 500,
      ...(await this.resolveLocality(dto.lat, dto.lng)),
    });

    return this.hubs.save(hub);
  }

  /**
   * Best-effort place name for a hub coordinate.
   *
   * Enrolling a hub must not depend on a third-party geocoder being up, so a
   * failure here returns empty columns and logs. The label is recoverable at any
   * time — `npm run hub:locality` fills in whatever is still missing — whereas a
   * hub that could not be created because OSM was rate-limiting would block real
   * field work for a cosmetic field.
   */
  private async resolveLocality(
    lat: number,
    lng: number,
  ): Promise<Pick<HubEntity, "locality" | "localityResolvedAt" | "localityAttribution">> {
    const absent = {
      locality: null,
      localityResolvedAt: null,
      localityAttribution: null,
    };

    // The client is written to report failures rather than throw, but it is an
    // I/O boundary: a caught exception here is the difference between a hub with
    // no label and no hub at all.
    let result: GeocodeResult;
    try {
      result = await this.geocoder.reverseGeocode(lat, lng);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.logger.warn(`locality lookup threw for ${lat}, ${lng}: ${detail}`);
      return absent;
    }

    if (!result.ok) {
      // "disabled" is a configuration choice rather than a fault, so it is not
      // worth a warning on every hub creation.
      if (result.reason !== "disabled") {
        this.logger.warn(`no locality for ${lat}, ${lng}: ${result.reason} — ${result.detail}`);
      }
      return absent;
    }

    return {
      locality: result.value.label,
      localityResolvedAt: new Date(),
      localityAttribution: result.value.attribution,
    };
  }
}
