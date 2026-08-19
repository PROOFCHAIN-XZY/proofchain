import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Injectable, Optional } from "@nestjs/common";
import { loadConfig } from "../config/configuration";

/**
 * Content-addressed storage for weigh-in photo bytes.
 *
 * The file's name IS its sha256, which is the same digest the collector's
 * device signed into the weigh-in payload. That has three consequences worth
 * stating, because they are the reasons for the design:
 *
 *  1. A stored photo cannot drift from the record that references it. Changing
 *     one byte changes the path, so a tampered image is not a modified photo —
 *     it is a different photo that no event points at.
 *  2. Two collectors photographing the same scene, or one device retrying an
 *     upload, write the same bytes to the same path. Storing it twice is a
 *     no-op rather than a conflict.
 *  3. Nothing about the path is guessable from an event id, so the store does
 *     not leak "which weigh-ins have photos" to anyone who can list a directory.
 */

export interface StoredPhoto {
  sha256: string;
  bytes: number;
  /** Path relative to the storage root — what goes in photoUri. */
  relativePath: string;
}

@Injectable()
export class PhotoStore {
  private readonly root: string;

  /**
   * The root override is for tests, which write into a temp directory.
   * `@Optional()` keeps Nest from trying to inject a String for it at boot.
   */
  constructor(@Optional() root?: string) {
    this.root = resolve(root ?? loadConfig().photoStorageDir);
  }

  static sha256Of(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
  }

  /**
   * Fanned out two levels on the first four hex characters.
   *
   * A single flat directory holding a pilot's worth of photos is slow to list
   * and unpleasant to back up; 256 × 256 buckets keeps any one directory small
   * without needing a migration later.
   */
  static relativePathFor(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`not a sha256 digest: ${sha256}`);
    }
    return join(sha256.slice(0, 2), sha256.slice(2, 4), `${sha256}.bin`);
  }

  absolutePathFor(sha256: string): string {
    return join(this.root, PhotoStore.relativePathFor(sha256));
  }

  /** Writes the bytes under their own digest. Safe to call repeatedly. */
  async put(bytes: Buffer): Promise<StoredPhoto> {
    const sha256 = PhotoStore.sha256Of(bytes);
    const relativePath = PhotoStore.relativePathFor(sha256);
    const absolute = join(this.root, relativePath);

    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, bytes);

    return { sha256, bytes: bytes.byteLength, relativePath };
  }

  async read(sha256: string): Promise<Buffer | null> {
    try {
      return await readFile(this.absolutePathFor(sha256));
    } catch {
      // Absent, unreadable or a bad digest all mean the same thing to a
      // caller: there is no photo to serve.
      return null;
    }
  }

  async has(sha256: string): Promise<boolean> {
    try {
      return (await stat(this.absolutePathFor(sha256))).isFile();
    } catch {
      return false;
    }
  }
}
