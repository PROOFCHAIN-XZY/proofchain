import {
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { PhotosService } from "./photos.service";
import { Public } from "../auth/auth.module";
import { RateLimit } from "../common/rate-limit.guard";

@ApiTags("photos")
@Controller("events/:id/photo")
export class PhotosController {
  constructor(private readonly photos: PhotosService) {}

  /**
   * Public for the same reason ingest is: the credential is the signature the
   * device already made over this photo's digest. Bytes that do not hash to
   * the signed photoHash are refused, so an anonymous caller cannot put
   * anything here that a verifier would ever see.
   *
   * Rate limited harder than ingest — a weigh-in is a few hundred bytes, a
   * photo is megabytes, and the same hub NAT address carries both.
   */
  @Public()
  @RateLimit(20, 60)
  @Post()
  @HttpCode(200)
  @ApiOperation({ summary: "Upload the photo bytes for a signed weigh-in" })
  async upload(@Param("id", ParseUUIDPipe) id: string, @Req() request: Request) {
    return this.photos.attach(id, await readBody(request));
  }

  /**
   * Content-addressed and therefore immutable: these bytes can never change
   * for this event, because different bytes would not match the signed hash.
   * A year-long cache is honest here in a way it rarely is.
   */
  @Public()
  @Get()
  @Header("Cache-Control", "public, max-age=31536000, immutable")
  @ApiOperation({ summary: "The weigh-in photo, if it has been uploaded" })
  async serve(
    @Param("id", ParseUUIDPipe) id: string,
    @Headers("if-none-match") ifNoneMatch: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const photo = await this.photos.forEvent(id);
    if (!photo) throw new NotFoundException(`no photo has been uploaded for event ${id}`);

    // The digest is a perfect ETag: it is the identity of the bytes, not a
    // guess derived from mtime or size.
    const etag = `"${photo.sha256}"`;
    if (ifNoneMatch === etag) {
      response.status(304).end();
      return;
    }

    response
      .status(200)
      .setHeader("ETag", etag)
      .setHeader("Content-Type", photo.contentType)
      .setHeader("Content-Length", String(photo.bytes.byteLength))
      // Evidence, not a web asset: nothing here should be interpreted as
      // markup or executed if the content check is ever bypassed.
      .setHeader("X-Content-Type-Options", "nosniff")
      .setHeader("Content-Disposition", `inline; filename="${photo.sha256}"`)
      .end(photo.bytes);
  }
}

/**
 * Collects the raw request body.
 *
 * The global JSON body parser does not apply here — this endpoint receives
 * image bytes, not JSON — and the service enforces the size ceiling once the
 * bytes are in hand.
 */
async function readBody(request: Request): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}
