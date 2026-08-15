import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Test } from "@nestjs/testing";
import { ValidationPipe, type INestApplication } from "@nestjs/common";
import { APP_GUARD, Reflector } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import request from "supertest";
import { BatchesController } from "../src/batches/batches.controller";
import { BatchesService } from "../src/batches/batches.service";
import { getRepositoryToken } from "@nestjs/typeorm";
import { AnchorWorkerGuard, JwtAuthGuard } from "../src/auth/auth.module";
import { UserEntity } from "../src/database/entities";
import { stubRequiredEnv } from "./support/services";

/**
 * The reporting endpoint is guarded for a sharper reason than the write-back it
 * sits beside: an anonymous caller who could post failures would be able to
 * park every sealed batch in maximum backoff and stop anchoring altogether,
 * while the pipeline carried on looking merely slow.
 */

const TOKEN = "test-anchor-worker-token";
const BATCH = "11111111-2222-3333-4444-555555555555";

const recordAnchorFailure = vi.fn();
let app: INestApplication;

beforeAll(async () => {
  stubRequiredEnv({ ANCHOR_WORKER_TOKEN: TOKEN });

  const moduleRef = await Test.createTestingModule({
    controllers: [BatchesController],
    providers: [
      { provide: BatchesService, useValue: { recordAnchorFailure } },
      { provide: JwtService, useValue: { verifyAsync: async () => ({ role: "operator" }) } },
      // JwtAuthGuard re-reads the account on every authenticated request, so
      // that deactivating a user takes effect immediately rather than whenever
      // their token happens to expire. The route under test is @Public() and
      // never reaches the lookup, but the guard is still constructed.
      { provide: getRepositoryToken(UserEntity), useValue: { findOne: async () => null } },
      Reflector,
      AnchorWorkerGuard,
      { provide: APP_GUARD, useClass: JwtAuthGuard },
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
  await app.init();
});

afterAll(async () => {
  await app?.close();
});

beforeEach(() => {
  recordAnchorFailure.mockReset();
  recordAnchorFailure.mockResolvedValue({ attemptNumber: 1, outcome: "failed" });
});

function post(body: unknown, token?: string) {
  const req = request(app.getHttpServer()).post(`/batches/${BATCH}/anchor-failure`);
  if (token !== undefined) req.set("x-anchor-worker-token", token);
  return req.send(body as object);
}

describe("POST /batches/:id/anchor-failure", () => {
  it("records a failure presented with the worker token", async () => {
    const response = await post({ outcome: "failed", detail: "horizon 504" }, TOKEN);

    expect(response.status).toBe(201);
    expect(recordAnchorFailure).toHaveBeenCalledWith(BATCH, {
      outcome: "failed",
      detail: "horizon 504",
    });
  });

  it("rejects a caller with no token", async () => {
    const response = await post({ outcome: "failed" });

    expect(response.status).toBe(401);
    expect(recordAnchorFailure).not.toHaveBeenCalled();
  });

  it("rejects a caller with the wrong token", async () => {
    const response = await post({ outcome: "failed" }, "not-the-token");

    expect(response.status).toBe(401);
    expect(recordAnchorFailure).not.toHaveBeenCalled();
  });

  it("rejects an outcome outside the two the worker can report", async () => {
    // "succeeded" is written by the anchor write-back, which proves the anchor
    // exists. Accepting it here would let a caller assert success with nothing
    // behind it.
    const response = await post({ outcome: "succeeded" }, TOKEN);

    expect(response.status).toBe(400);
    expect(recordAnchorFailure).not.toHaveBeenCalled();
  });

  it("rejects a malformed transaction hash", async () => {
    const response = await post({ outcome: "unverified", stellarTxHash: "nope" }, TOKEN);

    expect(response.status).toBe(400);
  });

  it("rejects unknown fields rather than silently dropping them", async () => {
    // A worker sending fields this version does not know about is a version
    // mismatch worth failing loudly on.
    const response = await post({ outcome: "failed", batchStatus: "sold" }, TOKEN);

    expect(response.status).toBe(400);
  });

  it("caps the stored error text", async () => {
    const response = await post({ outcome: "failed", detail: "x".repeat(5000) }, TOKEN);

    expect(response.status).toBe(400);
  });
});
