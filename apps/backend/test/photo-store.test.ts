import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PhotoStore } from "../src/photos/photo-store";

/**
 * The store is content-addressed, so most of its guarantees are properties of
 * the path function rather than of the filesystem. Those are the ones tested
 * hardest — a wrong path is how a photo silently stops matching its record.
 */

let root: string;
let store: PhotoStore;

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "proofchain-photos-"));
  store = new PhotoStore(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("PhotoStore paths", () => {
  it("names the file after the digest of its contents", () => {
    const sha256 = PhotoStore.sha256Of(JPEG);

    expect(PhotoStore.relativePathFor(sha256)).toBe(
      join(sha256.slice(0, 2), sha256.slice(2, 4), `${sha256}.bin`),
    );
  });

  it("refuses anything that is not a sha256 digest", () => {
    // The digest reaches this function from a URL parameter. Unchecked, "../.."
    // would resolve outside the storage root.
    expect(() => PhotoStore.relativePathFor("../../etc/passwd")).toThrow(/not a sha256/);
    expect(() => PhotoStore.relativePathFor("ABC")).toThrow(/not a sha256/);
    // Uppercase hex is a different string and would address a different file.
    expect(() => PhotoStore.relativePathFor("A".repeat(64))).toThrow(/not a sha256/);
  });

  it("keeps every stored file inside the storage root", async () => {
    const stored = await store.put(JPEG);

    expect(store.absolutePathFor(stored.sha256).startsWith(root)).toBe(true);
  });
});

describe("PhotoStore.put", () => {
  it("writes the bytes and reports the digest and size", async () => {
    const stored = await store.put(JPEG);

    expect(stored.sha256).toBe(PhotoStore.sha256Of(JPEG));
    expect(stored.bytes).toBe(JPEG.byteLength);
    expect(await readFile(join(root, stored.relativePath))).toEqual(JPEG);
  });

  it("is a no-op when the same bytes are stored twice", async () => {
    const first = await store.put(JPEG);
    const second = await store.put(JPEG);

    // A field upload that times out after the write but before the response
    // is retried by the phone. That retry must not fail or duplicate.
    expect(second.relativePath).toBe(first.relativePath);
    expect(await readFile(join(root, second.relativePath))).toEqual(JPEG);
  });

  it("stores different photos separately", async () => {
    const other = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x10]);

    const a = await store.put(JPEG);
    const b = await store.put(other);

    expect(a.relativePath).not.toBe(b.relativePath);
  });
});

describe("PhotoStore.read", () => {
  it("returns the stored bytes", async () => {
    const stored = await store.put(JPEG);

    expect(await store.read(stored.sha256)).toEqual(JPEG);
  });

  it("returns null for a photo that was never stored", async () => {
    expect(await store.read("b".repeat(64))).toBeNull();
    expect(await store.has("b".repeat(64))).toBe(false);
  });

  it("returns null rather than throwing for a malformed digest", async () => {
    // Reached from a URL parameter; a throw here would be a 500 on a route
    // whose honest answer is 404.
    expect(await store.read("not-a-digest")).toBeNull();
  });
});
