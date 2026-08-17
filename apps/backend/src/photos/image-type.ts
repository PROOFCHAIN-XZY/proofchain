/**
 * Image type detection from the leading bytes.
 *
 * Two jobs, and only the second is about security:
 *
 *  1. Serving. The store is content-addressed, so filenames carry no extension
 *     and the media type has to be recovered from the bytes themselves.
 *  2. Refusing to store a payload that is not an image at all. The hash check
 *     already prevents substituting a *different* photo, but it cannot stop a
 *     device from having signed the digest of an HTML file or a script in the
 *     first place, and those bytes would later be served back from our origin.
 *
 * Detection is by signature rather than by a client-supplied Content-Type,
 * because the client here is the same party we are trying not to have to trust.
 */

export type ImageType = "image/jpeg" | "image/png" | "image/webp" | "image/heic";

interface Signature {
  type: ImageType;
  /** Byte offset the magic starts at. */
  offset: number;
  magic: number[];
}

const SIGNATURES: Signature[] = [
  { type: "image/jpeg", offset: 0, magic: [0xff, 0xd8, 0xff] },
  { type: "image/png", offset: 0, magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  // RIFF....WEBP — the four size bytes between the two markers are skipped.
  { type: "image/webp", offset: 0, magic: [0x52, 0x49, 0x46, 0x46] },
  // ISO-BMFF brand box; iPhones default to HEIC and collectors use iPhones.
  { type: "image/heic", offset: 4, magic: [0x66, 0x74, 0x79, 0x70] },
];

function matches(bytes: Buffer, signature: Signature): boolean {
  const end = signature.offset + signature.magic.length;
  if (bytes.byteLength < end) return false;

  return signature.magic.every((byte, index) => bytes[signature.offset + index] === byte);
}

/** The image type of these bytes, or null if they are not a recognised image. */
export function detectImageType(bytes: Buffer): ImageType | null {
  for (const signature of SIGNATURES) {
    if (!matches(bytes, signature)) continue;

    // RIFF is a container: AVI and WAV share the header, so the WEBP brand at
    // offset 8 is what actually distinguishes an image.
    if (signature.type === "image/webp") {
      if (bytes.byteLength < 12 || bytes.subarray(8, 12).toString("ascii") !== "WEBP") {
        continue;
      }
    }

    // Likewise ftyp: the brand decides whether the file is HEIC, AVIF or an
    // MP4 video. Only the still-image brands are accepted.
    if (signature.type === "image/heic") {
      const brand = bytes.subarray(8, 12).toString("ascii");
      if (!["heic", "heix", "hevc", "mif1", "msf1"].includes(brand)) continue;
    }

    return signature.type;
  }

  return null;
}
