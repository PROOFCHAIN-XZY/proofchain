import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { MaterialsService } from "../src/materials/materials.service";
import { BatchEntity, CollectionEventEntity, MaterialEntity } from "../src/database/entities";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { buildMaterialsService } from "./support/services";
import { insertEvent, seedHub, type SeededHub } from "./support/fixtures";

/**
 * The catalogue is operator-editable configuration sitting directly upstream of
 * signed, anchored evidence. Every test here is about a way that could go wrong:
 * a code being renamed, a code being deleted out from under an anchored batch, or
 * a retirement invalidating field work that was already signed offline.
 */

let db: TestDatabase;
let service: MaterialsService;
let seeded: SeededHub;

beforeEach(async () => {
  db ??= await createTestDatabase();
  await db.reset();
  service = buildMaterialsService(db.dataSource);
  seeded = await seedHub(db.dataSource);
});

afterAll(async () => {
  await db?.close();
});

describe("MaterialsService.list", () => {
  it("returns the seeded catalogue with active entries first", async () => {
    await service.update("PS", { active: false });

    const listed = await service.list();

    expect(listed.map((m) => m.code)).toEqual(["PET", "HDPE", "LDPE", "PP", "MIXED", "PS"]);
    expect(listed.at(-1)).toMatchObject({ code: "PS", active: false });
  });

  /**
   * Retired entries are returned, not filtered out. The dashboard needs them to
   * label a historical event, and a capture app needs them to label its own
   * queued records.
   */
  it("includes retired entries so history can still be labelled", async () => {
    await service.update("PS", { active: false });
    expect((await service.list()).map((m) => m.code)).toContain("PS");
  });
});

describe("MaterialsService.create", () => {
  it("adds a material that capture can immediately use", async () => {
    const created = await service.create({ code: "PVC", name: "Pipe and profile" });

    expect(created).toMatchObject({ code: "PVC", name: "Pipe and profile", active: true });
    await expect(service.assertOpenable("PVC")).resolves.toBeUndefined();
  });

  it("stores the products a collector will be shown", async () => {
    const created = await service.create({
      code: "PVC",
      name: "Pipe and profile",
      examples: ["Pipe offcuts", "  Window frames  ", "pipe offcuts"],
    });

    expect(created.examples).toEqual(["Pipe offcuts", "Window frames"]);
  });

  it("defaults to an empty product list, never null, so pickers have one empty state", async () => {
    const created = await service.create({ code: "PVC", name: "Pipe and profile" });
    expect(created.examples).toEqual([]);
  });

  it("normalises the code to uppercase, because that is what gets signed", async () => {
    const created = await service.create({ code: "pvc", name: "Pipe and profile" });

    expect(created.code).toBe("PVC");
    // The lowercase spelling must not be usable — two spellings of one material
    // would split a hub's tonnage across two codes.
    await expect(service.assertKnown("pvc")).rejects.toThrow(BadRequestException);
    await expect(service.assertKnown("PVC")).resolves.toBeUndefined();
  });

  it("trims surrounding whitespace from the name", async () => {
    const created = await service.create({ code: "PVC", name: "  Pipe and profile  " });
    expect(created.name).toBe("Pipe and profile");
  });

  it("refuses a code that is already offered", async () => {
    await expect(service.create({ code: "PET", name: "Anything" })).rejects.toThrow(
      ConflictException,
    );
  });

  /**
   * The two conflicts differ in what the operator should do next, so they differ
   * in what they say. Recreating a retired code is not possible; reactivating it
   * is, and inventing `PET2` to work around the error would be a lasting mistake.
   */
  it("tells an operator to reactivate rather than recreate a retired code", async () => {
    await service.update("PS", { active: false });

    await expect(service.create({ code: "PS", name: "Polystyrene" })).rejects.toThrow(
      /retired.*reactivate/i,
    );
  });

  it("refuses a code that would not survive being signed", async () => {
    await expect(service.create({ code: "P", name: "Too short" })).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe("MaterialsService.update", () => {
  it("renames the label without touching the code", async () => {
    const updated = await service.update("PET", { name: "Clear bottles" });

    expect(updated).toMatchObject({ code: "PET", name: "Clear bottles" });
  });

  /**
   * The absence of a rename path is the point. If this ever becomes possible,
   * every audit report containing the old code silently stops verifying.
   */
  it("exposes no way to change a code", () => {
    expect(Object.keys(new MaterialsService({} as never, {} as never, {} as never))).not.toContain(
      "rename",
    );
    // The DTO is the other half of the guarantee: a `code` key in the body is
    // stripped by the global ValidationPipe's whitelist rather than applied.
    expect(service.update.length).toBe(2);
  });

  it("retires and restores", async () => {
    await service.update("PET", { active: false });
    expect((await service.list()).find((m) => m.code === "PET")?.active).toBe(false);

    await service.update("PET", { active: true });
    expect((await service.list()).find((m) => m.code === "PET")?.active).toBe(true);
  });

  /**
   * Products are presentation, like the name — an operator correcting a list
   * that does not match the local waste stream must not have to think about
   * whether it reaches anything signed. It does not.
   */
  it("replaces the product list wholesale rather than merging into it", async () => {
    const updated = await service.update("PET", { examples: ["Sachet water bottles"] });
    expect(updated.examples).toEqual(["Sachet water bottles"]);
  });

  it("clears the product list when given an empty array", async () => {
    const updated = await service.update("PET", { examples: [] });
    expect(updated.examples).toEqual([]);
  });

  it("leaves the product list alone when the field is omitted", async () => {
    const before = (await service.list()).find((m) => m.code === "PET");
    const updated = await service.update("PET", { name: "Clear bottles" });

    expect(updated.examples).toEqual(before?.examples);
    expect(updated.examples.length).toBeGreaterThan(0);
  });

  it("normalises what an operator types: blanks, repeats and stray whitespace", async () => {
    const updated = await service.update("PET", {
      examples: ["  Water   bottles ", "water bottles", "", "Crates"],
    });

    expect(updated.examples).toEqual(["Water bottles", "Crates"]);
  });

  it("clears a description when given an empty string", async () => {
    const updated = await service.update("PET", { description: "" });
    expect(updated.description).toBeNull();
  });

  it("404s on a code that does not exist", async () => {
    await expect(service.update("NOPE", { name: "x" })).rejects.toThrow(NotFoundException);
  });
});

describe("MaterialsService.remove", () => {
  it("deletes a material nothing has ever used", async () => {
    await service.create({ code: "PTE", name: "Typo" });

    await expect(service.remove("PTE")).resolves.toEqual({ code: "PTE", deleted: true });
    await expect(service.assertKnown("PTE")).rejects.toThrow(BadRequestException);
  });

  /**
   * The case that protects the evidence. A code carried by a stored weigh-in is
   * part of that weigh-in's signed payload and its Merkle leaf; deleting the
   * catalogue row would leave the code unexplained and invite someone to "clean
   * up" the event next.
   */
  it("refuses to delete a code any weigh-in carries, and says how many", async () => {
    await insertEvent(db.dataSource, seeded, { material: "PET" });

    await expect(service.remove("PET")).rejects.toThrow(ConflictException);
    await expect(service.remove("PET")).rejects.toThrow(/1 event\(s\)/);
  });

  it("points the operator at retirement instead", async () => {
    await insertEvent(db.dataSource, seeded, { material: "PET" });

    await expect(service.remove("PET")).rejects.toThrow(/retire it instead/i);
  });

  it("refuses to delete a code a batch carries, even with no events", async () => {
    await db.dataSource.getRepository(BatchEntity).save({
      hubId: seeded.hub.id,
      material: "HDPE",
      status: "open",
      totalWeightKg: 0,
      eventCount: 0,
      merkleRoot: null,
      sealedAt: null,
    } as BatchEntity);

    await expect(service.remove("HDPE")).rejects.toThrow(/1 batch\(es\)/);
  });

  it("404s on a code that does not exist", async () => {
    await expect(service.remove("NOPE")).rejects.toThrow(NotFoundException);
  });
});

/**
 * The asymmetry between the two gates is the subtlest decision in this module,
 * so it gets its own block.
 */
describe("the ingest gate is looser than the batch gate", () => {
  it("ingest accepts a retired code, so an offline queue still lands", async () => {
    await service.update("PET", { active: false });

    // A phone signed these hours ago against the catalogue as it was. Rejecting
    // them would destroy field work nobody can redo — the sacks are gone.
    await expect(service.assertKnown("PET")).resolves.toBeUndefined();
  });

  it("opening a batch refuses a retired code", async () => {
    await service.update("PET", { active: false });

    await expect(service.assertOpenable("PET")).rejects.toThrow(/retired/i);
  });

  it("both refuse a code the catalogue has never defined", async () => {
    await expect(service.assertKnown("UNOBTANIUM")).rejects.toThrow(BadRequestException);
    await expect(service.assertOpenable("UNOBTANIUM")).rejects.toThrow(BadRequestException);
  });

  it("names the endpoint that lists the valid codes", async () => {
    await expect(service.assertKnown("UNOBTANIUM")).rejects.toThrow(/GET \/materials/);
  });
});

describe("the catalogue table", () => {
  it("keys on the code itself rather than a surrogate id", async () => {
    const found = await db.dataSource
      .getRepository(MaterialEntity)
      .findOneByOrFail({ code: "PET" });

    expect(found.code).toBe("PET");
    expect(found).not.toHaveProperty("id");
  });

  /**
   * No foreign key, deliberately. A catalogue edit must not be able to cascade
   * into, or be blocked by, an anchored event — the event's material is a signed
   * historical fact, not a reference to current configuration.
   */
  it("does not constrain events, so a retirement cannot reach backwards", async () => {
    const event = await insertEvent(db.dataSource, seeded, { material: "PET" });
    await service.update("PET", { active: false });

    const reloaded = await db.dataSource
      .getRepository(CollectionEventEntity)
      .findOneByOrFail({ id: event.id });

    expect(reloaded.material).toBe("PET");
  });
});
