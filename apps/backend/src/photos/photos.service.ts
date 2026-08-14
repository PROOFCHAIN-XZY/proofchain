import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { CollectionEventEntity } from "../database/entities";
import { loadConfig } from "../config/configuration";
import { detectImageType, type ImageType } from "./image-type";
import { PhotoStore } from "./photo-store";

/**
 * Attaches photo bytes to a weigh-in that already exists.
 *
 * The upload is deliberately a second step rather than part of ingest. A field
 * phone on a metered, intermittent link should be able to get the signed
 * weigh-in — the part that carries the weight, the location and the signature —
 * across in a few hundred bytes, and send the multi-megabyte photo whenever it
 * next has bandwidth. Coupling them would mean no record at all until both fit
 * through the same connection.
 *
 * Authorisation is the hash, not a token. The only bytes this will accept for
 * an event are bytes that hash to the photoHash the device already signed, and
 * that digest is fixed at capture time. A caller who does not have the original
 * photo cannot produce anything this will store, so no credential is needed to
 * make the endpoint safe — which is what keeps it usable from the same offline
 * queue that posts the weigh-in.
 */

export interface ServedPhoto {
  bytes: Buffer;
  sha256: string;
  contentType: string;
}

export interface PhotoAttachment {
  eventId: string;
  sha256: string;
  bytes: number;
  contentType: ImageType;
  /** True when this exact photo was already on file. */
  alreadyStored: boolean;
}

@Injectable()
export class PhotosService {
  private readonly logger = new Logger(PhotosService.name);
  private readonly maxBytes = loadConfig().maxPhotoBytes;

  constructor(
    @InjectRepository(CollectionEventEntity)
    private readonly events: Repository<CollectionEventEntity>,
    private readonly store: PhotoStore,
  ) {}

  async attach(eventId: string, bytes: Buffer): Promise<PhotoAttachment> {
    if (bytes.byteLength === 0) {
      throw new BadRequestException("photo body is empty");
    }
    if (bytes.byteLength > this.maxBytes) {
      throw new PayloadTooLargeException(
        `photo is ${bytes.byteLength} bytes; the limit is ${this.maxBytes}`,
      );
    }

    const event = await this.events.findOne({ where: { id: eventId } });
    if (!event) throw new NotFoundException(`event ${eventId} not found`);

    // Checked before the hash comparison so the rejection says which rule was
    // broken: "not an image" and "wrong image" need different responses from
    // the phone — one is a bug in the capture app, the other is corruption.
    const contentType = detectImageType(bytes);
    if (!contentType) {
      throw new BadRequestException(
        "photo body is not a recognised image (jpeg, png, webp or heic)",
      );
    }

    const sha256 = PhotoStore.sha256Of(bytes);

    // The check that makes the photo evidence rather than decoration. The
    // device signed this digest into the payload, so bytes that hash to
    // something else are, by construction, not the photo that was taken —
    // whether through corruption in transit or a deliberate substitution.
    if (sha256 !== event.photoHash) {
      this.logger.warn(
        `rejected photo for event ${eventId}: bytes hash to ${sha256}, payload declares ${event.photoHash}`,
      );
      throw new BadRequestException(
        `photo does not match the signed photoHash for this weigh-in (got ${sha256})`,
      );
    }

    const alreadyStored = await this.store.has(sha256);
    const stored = await this.store.put(bytes);

    await this.events.update({ id: eventId }, { photoUri: stored.relativePath });

    return { eventId, sha256, bytes: stored.bytes, contentType, alreadyStored };
  }

  /**
   * The photo for a weigh-in, ready to serve.
   *
   * Looked up through the event rather than by digest so a caller cannot walk
   * the store by guessing hashes: to read a photo you must already know which
   * event it belongs to, and event ids are UUIDs.
   */
  async forEvent(eventId: string): Promise<ServedPhoto | null> {
    const event = await this.events.findOne({ where: { id: eventId } });
    if (!event) throw new NotFoundException(`event ${eventId} not found`);

    // photoUri is only set once bytes have been verified and stored, so its
    // absence is the honest answer: the photo was never uploaded.
    if (!event.photoUri) return null;

    const bytes = await this.store.read(event.photoHash);
    if (!bytes) {
      // The row says stored, the disk disagrees. Loud, because it means the
      // evidence behind an already-issued audit report has gone missing.
      this.logger.error(
        `event ${eventId} references photo ${event.photoHash}, which is not in the store`,
      );
      return null;
    }

    return {
      bytes,
      sha256: event.photoHash,
      // Re-derived from the bytes on the way out rather than stored: the
      // response's declared type then cannot disagree with what is served.
      contentType: detectImageType(bytes) ?? "application/octet-stream",
    };
  }
}
