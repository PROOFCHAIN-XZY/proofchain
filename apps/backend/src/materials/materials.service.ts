import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  isMaterialCode,
  normaliseExamples,
  sortMaterials,
  type Material,
} from "@proofchain/shared";
import { BatchEntity, CollectionEventEntity, MaterialEntity } from "../database/entities";
import type { CreateMaterialDto, UpdateMaterialDto } from "../common/dto";

/**
 * The material catalogue.
 *
 * Two rules carry the whole design, both of them consequences of a material code
 * being part of the signed payload:
 *
 * 1. A code is append-only. There is no rename, because renaming a code that has
 *    been anchored would invalidate every audit report containing it. Operators
 *    edit `name`, which is presentation and never signed.
 * 2. Retiring is not deleting. `active: false` removes a material from the
 *    pickers and leaves history untouched. Outright deletion is permitted only
 *    for a code no event and no batch has ever used — a typo, in other words —
 *    because that is the one case where deletion cannot invalidate anything.
 */
@Injectable()
export class MaterialsService {
  constructor(
    @InjectRepository(MaterialEntity)
    private readonly materials: Repository<MaterialEntity>,
    @InjectRepository(CollectionEventEntity)
    private readonly events: Repository<CollectionEventEntity>,
    @InjectRepository(BatchEntity)
    private readonly batches: Repository<BatchEntity>,
  ) {}

  /**
   * The whole catalogue, retired entries included.
   *
   * Retired entries are returned on purpose, and to unauthenticated callers. The
   * dashboard needs them to label a historical event whose material is no longer
   * offered, and a capture app needs them to render its own queued records. A
   * material name is not a secret — it is "Polystyrene" — and withholding it
   * would only produce reports that show a bare code where they used to show a
   * name.
   */
  async list(): Promise<Material[]> {
    const rows = await this.materials.find();
    return sortMaterials(rows.map(toMaterial));
  }

  async create(dto: CreateMaterialDto): Promise<Material> {
    const code = dto.code.trim().toUpperCase();

    // The DTO already checked the shape, but uppercasing happens here, so
    // re-check: `pet ` passes @Matches only after normalisation.
    if (!isMaterialCode(code)) {
      throw new BadRequestException(
        `material code must be 2-16 uppercase characters, letters digits _ or -: got "${code}"`,
      );
    }

    const existing = await this.materials.findOne({ where: { code } });
    if (existing) {
      // Distinguish the two cases, because the fix differs. A retired code is
      // not "taken" from the operator's point of view — they want it back, and
      // reactivating it is the correct action rather than inventing `PET2`.
      throw new ConflictException(
        existing.active
          ? `material ${code} already exists`
          : `material ${code} exists but is retired — reactivate it instead of recreating it`,
      );
    }

    const saved = await this.materials.save(
      this.materials.create({
        code,
        name: dto.name.trim(),
        description: blankToNull(dto.description),
        examples: normaliseExamples(dto.examples),
        active: dto.active ?? true,
        sortOrder: dto.sortOrder ?? 100,
      }),
    );

    return toMaterial(saved);
  }

  /**
   * Edit the presentation of a material, or retire and restore it.
   *
   * `code` is intentionally absent from `UpdateMaterialDto`. There is no code
   * path in this service that can change a code, which is the point.
   */
  async update(code: string, dto: UpdateMaterialDto): Promise<Material> {
    const material = await this.require(code);

    if (dto.name !== undefined) material.name = dto.name.trim();
    if (dto.description !== undefined) material.description = blankToNull(dto.description);
    // Replace, never merge: an operator removing a wrong product must be able to.
    if (dto.examples !== undefined) material.examples = normaliseExamples(dto.examples);
    if (dto.active !== undefined) material.active = dto.active;
    if (dto.sortOrder !== undefined) material.sortOrder = dto.sortOrder;

    return toMaterial(await this.materials.save(material));
  }

  /**
   * Delete a material that has never been used.
   *
   * Refuses as soon as any event or batch carries the code, and says how many —
   * an operator who mistyped `PTE` an hour ago can remove it, while one trying to
   * tidy away `PS` after a year of collections is told what it would cost. The
   * alternative on offer is always retirement, so the answer to "remove this" is
   * never simply "no".
   */
  async remove(code: string): Promise<{ code: string; deleted: true }> {
    const material = await this.require(code);

    const [eventCount, batchCount] = await Promise.all([
      this.events.count({ where: { material: material.code } }),
      this.batches.count({ where: { material: material.code } }),
    ]);

    if (eventCount > 0 || batchCount > 0) {
      throw new ConflictException(
        `material ${material.code} is used by ${eventCount} event(s) and ${batchCount} batch(es) ` +
          `and cannot be deleted — its code is part of their signed payloads. Retire it instead ` +
          `(PATCH /materials/${material.code} {"active": false}), which hides it from new capture ` +
          `and leaves the record intact.`,
      );
    }

    await this.materials.delete({ code: material.code });
    return { code: material.code, deleted: true };
  }

  /**
   * Gate for ingesting a signed weigh-in: the code must exist, but it need not
   * be active.
   *
   * The asymmetry with `assertOpenable` below is the important part. Capture is
   * offline-first, so a phone can hold a queue signed hours ago against a
   * catalogue that has since changed. If retiring a material rejected those
   * records, an operator tidying the catalogue at lunchtime would silently
   * destroy a morning of unsynced, already-signed field work — and the collector
   * would have no way to redo it, because the sacks are gone. Retiring is meant
   * to stop new selection, not to invalidate work in flight.
   *
   * An unknown code is still refused. That is not a stale catalogue, it is a
   * payload asserting a material this system has never defined.
   */
  async assertKnown(code: string): Promise<void> {
    const exists = await this.materials.exist({ where: { code } });
    if (!exists) {
      throw new BadRequestException(
        `unknown material "${code}" — not in the catalogue. See GET /materials.`,
      );
    }
  }

  /**
   * Gate for opening a batch: the code must exist *and* be active.
   *
   * An operator opening a batch is making a forward-looking decision with a live
   * catalogue in front of them, so a retired material here is a mistake worth
   * blocking rather than history worth preserving.
   */
  async assertOpenable(code: string): Promise<void> {
    const material = await this.materials.findOne({ where: { code } });
    if (!material) {
      throw new BadRequestException(
        `unknown material "${code}" — not in the catalogue. See GET /materials.`,
      );
    }
    if (!material.active) {
      throw new BadRequestException(
        `material ${code} is retired and cannot be used for a new batch. ` +
          `Reactivate it first if this is intended.`,
      );
    }
  }

  private async require(code: string): Promise<MaterialEntity> {
    const material = await this.materials.findOne({ where: { code: code.trim().toUpperCase() } });
    if (!material) throw new NotFoundException(`material ${code} not found`);
    return material;
  }
}

/**
 * An absent description is null, never "".
 *
 * The dashboard's edit form always submits the field, so clearing it arrives as
 * an empty string. Storing that verbatim would leave a row that is neither absent
 * nor useful, and the UI's `description ?? "—"` would render blank instead of a
 * dash. Note that `?? null` alone does not do this: "" is not nullish.
 */
function blankToNull(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function toMaterial(entity: MaterialEntity): Material {
  return {
    code: entity.code,
    name: entity.name,
    description: entity.description,
    // Normalised on the way out as well as in. A row written before this column
    // existed, or by a driver that hands an empty array back in its own
    // spelling, must still reach a picker as a plain array.
    examples: normaliseExamples(entity.examples),
    active: entity.active,
    sortOrder: entity.sortOrder,
  };
}
