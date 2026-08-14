import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { PhotosController } from "../src/photos/photos.controller";
import { PhotosService } from "../src/photos/photos.service";
import { PhotoStore } from "../src/photos/photo-store";
import { stubRequiredEnv } from "./support/services";

/**
 * HTTP-level behaviour: the raw body reaching the service intact, and the
 * caching contract on the way back out. Neither is visible from the service
 * tests, and both are easy to break without noticing.
 */

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const SHA = PhotoStore.sha256Of(JPEG);
const EVENT_ID = "11111111-2222-3333-4444-555555555555";

const attach = vi.fn();
const forEvent = vi.fn();

let app: INestApplication;

beforeAll(async () => {
  stubRequiredEnv();
  const moduleRef = await Test.createTestingModule({
    controllers: [PhotosController],
    providers: [{ provide: PhotosService, useValue: { attach, forEvent } }],
  }).compile();

  app = moduleRef.createNestApplication();
  await app.init();
});

afterAll(async () => {
  await app?.close();
});

describe("POST /events/:id/photo", () => {
  it("hands the raw bytes to the service unmodified", async () => {
    attach.mockResolvedValueOnce({
      eventId: EVENT_ID,
      sha256: SHA,
      bytes: JPEG.byteLength,
      contentType: "image/jpeg",
      alreadyStored: false,
    });

    const response = await request(app.getHttpServer())
      .post(`/events/${EVENT_ID}/photo`)
      .set("content-type", "application/octet-stream")
      .send(JPEG);

    expect(response.status).toBe(200);
    // Byte-for-byte: any transcoding here changes the digest and the upload
    // stops matching the signature the device made.
    const [, received] = attach.mock.calls.at(-1)!;
    expect(Buffer.compare(received as Buffer, JPEG)).toBe(0);
  });

  it("rejects a non-UUID event id before touching the service", async () => {
    attach.mockClear();

    const response = await request(app.getHttpServer()).post("/events/not-a-uuid/photo").send("x");

    expect(response.status).toBe(400);
    expect(attach).not.toHaveBeenCalled();
  });
});

describe("GET /events/:id/photo", () => {
  it("serves the bytes with the derived content type and a digest ETag", async () => {
    forEvent.mockResolvedValueOnce({ bytes: JPEG, sha256: SHA, contentType: "image/jpeg" });

    const response = await request(app.getHttpServer()).get(`/events/${EVENT_ID}/photo`);

    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toContain("image/jpeg");
    expect(response.headers.etag).toBe(`"${SHA}"`);
    expect(Buffer.compare(response.body, JPEG)).toBe(0);
  });

  it("marks the response immutable and non-sniffable", async () => {
    forEvent.mockResolvedValueOnce({ bytes: JPEG, sha256: SHA, contentType: "image/jpeg" });

    const response = await request(app.getHttpServer()).get(`/events/${EVENT_ID}/photo`);

    // Immutable is truthful here: different bytes would not match the signed
    // hash, so this URL's content can never change.
    expect(response.headers["cache-control"]).toContain("immutable");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("answers 304 when the client already holds these bytes", async () => {
    forEvent.mockResolvedValueOnce({ bytes: JPEG, sha256: SHA, contentType: "image/jpeg" });

    const response = await request(app.getHttpServer())
      .get(`/events/${EVENT_ID}/photo`)
      .set("if-none-match", `"${SHA}"`);

    // An auditor paging through a batch report re-requests every photo; the
    // digest makes revalidation exact rather than heuristic.
    expect(response.status).toBe(304);
  });

  it("404s when no photo has been uploaded", async () => {
    forEvent.mockResolvedValueOnce(null);

    const response = await request(app.getHttpServer()).get(`/events/${EVENT_ID}/photo`);

    expect(response.status).toBe(404);
    expect(response.body.message).toMatch(/no photo has been uploaded/);
  });
});
