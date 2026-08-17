import { describe, expect, it } from "vitest";
import { detectImageType } from "../src/photos/image-type";

/**
 * Signature detection, tested on the container formats that share a header
 * with something that is not an image — those are the cases where a naive
 * four-byte check quietly accepts a video or an audio file.
 */

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

function riff(brand: string): Buffer {
  return Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    Buffer.from([0x24, 0x00, 0x00, 0x00]),
    Buffer.from(brand, "ascii"),
    Buffer.alloc(8),
  ]);
}

function isoBmff(brand: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from("ftyp", "ascii"),
    Buffer.from(brand, "ascii"),
    Buffer.alloc(8),
  ]);
}

describe("detectImageType", () => {
  it("recognises the formats phones actually produce", () => {
    expect(detectImageType(jpeg)).toBe("image/jpeg");
    expect(detectImageType(png)).toBe("image/png");
    expect(detectImageType(riff("WEBP"))).toBe("image/webp");
    // iPhones default to HEIC, and collectors use iPhones.
    expect(detectImageType(isoBmff("heic"))).toBe("image/heic");
    expect(detectImageType(isoBmff("mif1"))).toBe("image/heic");
  });

  it("rejects a RIFF container that is not WEBP", () => {
    // AVI and WAV open with the same four bytes as WEBP.
    expect(detectImageType(riff("AVI "))).toBeNull();
    expect(detectImageType(riff("WAVE"))).toBeNull();
  });

  it("rejects an ISO-BMFF container that is not a still image", () => {
    // An MP4 shares HEIC's ftyp box; only the brand distinguishes them.
    expect(detectImageType(isoBmff("isom"))).toBeNull();
    expect(detectImageType(isoBmff("mp42"))).toBeNull();
  });

  it("rejects documents, scripts and archives", () => {
    expect(detectImageType(Buffer.from("<!doctype html>"))).toBeNull();
    expect(detectImageType(Buffer.from("%PDF-1.7"))).toBeNull();
    expect(detectImageType(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBeNull();
  });

  it("rejects a buffer too short to carry a signature", () => {
    // A truncated upload must not be read past its end.
    expect(detectImageType(Buffer.alloc(0))).toBeNull();
    expect(detectImageType(Buffer.from([0xff, 0xd8]))).toBeNull();
    expect(detectImageType(Buffer.from("RIFF", "ascii"))).toBeNull();
  });

  it("does not accept an image signature that starts late", () => {
    // Prefixing real JPEG bytes with junk is the trivial way to smuggle
    // arbitrary leading content past an offset-agnostic scan.
    expect(detectImageType(Buffer.concat([Buffer.from("junk"), jpeg]))).toBeNull();
  });
});
