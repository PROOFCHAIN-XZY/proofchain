import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { CollectionEventEntity } from "../src/database/entities";
import { PhotoStore } from "../src/photos/photo-store";
import { PhotosService } from "../src/photos/photos.service";
import { createTestDatabase, type TestDatabase } from "./support/database";
import { insertEvent, seedHub, type SeededHub } from "./support/fixtures";
import { stubRequiredEnv } from "./support/services";

/**
 * Attaching a photo is the step that turns photo_present from a check on a
 * string's shape into a check an auditor can act on. Its one real rule is that
 * the bytes must hash to the digest the device signed.
 */

let db: TestDatabase;
let seeded: SeededHub;
let service: PhotosService;
let store: PhotoStore;
let root: string;

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const JPEG_SHA = PhotoStore.sha256Of(JPEG);
/** A different, equally valid image — the realistic substitution. */
const OTHER_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x20, 0x45, 0x78, 0x69, 0x66]);

beforeEach(async () => {
  // The service reads its ceiling at construction, so a test that lowers it
  // would otherwise leak that ceiling into every test built afterwards.
  delete process.env.MAX_PHOTO_BYTES;
  stubRequiredEnv();
  db ??= await createTestDatabase();
  await db.reset();
  root = await mkdtemp(join(tmpdir(), "proofchain-photos-"));
  store = new PhotoStore(root);
  service = new PhotosService(db.dataSource.getRepository(CollectionEventEntity), store);
  seeded = await seedHub(db.dataSource);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

afterAll(async () => {
  await db?.close();
});

describe("PhotosService.attach", () => {
  it("stores the photo and records its path on the event", async () => {
    const event = await insertEvent(db.dataSource, seeded, { photoHash: JPEG_SHA });

    const result = await service.attach(event.id, JPEG);

    expect(result.sha256).toBe(JPEG_SHA);
    expect(result.bytes).toBe(JPEG.byteLength);
    expect(await store.read(JPEG_SHA)).toEqual(JPEG);

    const reloaded = await db.dataSource
      .getRepository(CollectionEventEntity)
      .findOneByOrFail({ id: event.id });
    // photoUri has been null on every row since the schema was written.
    expect(reloaded.photoUri).toBe(PhotoStore.relativePathFor(JPEG_SHA));
  });

  it("rejects bytes that do not hash to the signed photoHash", async () => {
    const event = await insertEvent(db.dataSource, seeded, { photoHash: JPEG_SHA });
    const substitute = OTHER_JPEG;

    // The substitution a fraudulent credit needs: a real signed weigh-in, with
    // a photo of something else attached to it afterwards.
    await expect(service.attach(event.id, substitute)).rejects.toThrow(
      /does not match the signed photoHash/,
    );
  });

  it("leaves the event untouched when the bytes are rejected", async () => {
    const event = await insertEvent(db.dataSource, seeded, { photoHash: JPEG_SHA });

    await expect(service.attach(event.id, OTHER_JPEG)).rejects.toThrow();

    const reloaded = await db.dataSource
      .getRepository(CollectionEventEntity)
      .findOneByOrFail({ id: event.id });
    expect(reloaded.photoUri).toBeNull();
    expect(await store.has(PhotoStore.sha256Of(OTHER_JPEG))).toBe(false);
  });

  it("is idempotent for a retried upload", async () => {
    const event = await insertEvent(db.dataSource, seeded, { photoHash: JPEG_SHA });

    const first = await service.attach(event.id, JPEG);
    const second = await service.attach(event.id, JPEG);

    expect(first.alreadyStored).toBe(false);
    expect(second.alreadyStored).toBe(true);
    expect(second.sha256).toBe(first.sha256);
  });

  it("404s for an event that does not exist", async () => {
    await expect(
      service.attach("00000000-0000-0000-0000-000000000000", JPEG),
    ).rejects.toThrow(/not found/);
  });

  it("rejects an empty body", async () => {
    const event = await insertEvent(db.dataSource, seeded, { photoHash: JPEG_SHA });

    // sha256 of nothing is a perfectly valid digest, so an empty upload would
    // otherwise be storable against an event whose photoHash happened to be it.
    await expect(service.attach(event.id, Buffer.alloc(0))).rejects.toThrow(/empty/);
  });

  it("rejects a photo above the size ceiling", async () => {
    stubRequiredEnv({ MAX_PHOTO_BYTES: "16" });
    const small = new PhotosService(
      db.dataSource.getRepository(CollectionEventEntity),
      store,
    );
    const event = await insertEvent(db.dataSource, seeded, { photoHash: JPEG_SHA });

    await expect(service.attach(event.id, Buffer.alloc(64))).rejects.toThrow();
    await expect(small.attach(event.id, Buffer.alloc(64))).rejects.toThrow(/limit is 16/);
  });

  it("refuses a body that is not an image at all", async () => {
    const notAnImage = Buffer.from("<html><script>alert(1)</script></html>");
    const event = await insertEvent(db.dataSource, seeded, {
      photoHash: PhotoStore.sha256Of(notAnImage),
    });

    // The hash check cannot catch this: the device really did sign this
    // digest. But these bytes would later be served back from our own origin,
    // so the content itself has to be refused.
    await expect(service.attach(event.id, notAnImage)).rejects.toThrow(/not a recognised image/);
  });

  it("attaches to the quarantined event too", async () => {
    const event = await insertEvent(db.dataSource, seeded, {
      photoHash: JPEG_SHA,
      quarantined: true,
    });

    // Quarantined records are the evidence that fraud detection works. A
    // rejected weigh-in is exactly the one an investigator wants to look at.
    await expect(service.attach(event.id, JPEG)).resolves.toMatchObject({ sha256: JPEG_SHA });
  });
});
