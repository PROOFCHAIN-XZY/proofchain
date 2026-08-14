import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Records every attempt to anchor a batch, successful or not.
 *
 * Additive only: no existing table is touched, so this is safe to apply to a
 * database already holding sealed and anchored batches. Batches anchored before
 * this migration simply have no attempt history, which reads correctly — we did
 * not record one.
 */
export class AnchorAttempts1786400000000 implements MigrationInterface {
  name = "AnchorAttempts1786400000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "anchor_attempts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "batchId" uuid NOT NULL, "attemptNumber" integer NOT NULL, "outcome" character varying NOT NULL, "detail" text, "stellarTxHash" character varying, "occurredAt" TIMESTAMP WITH TIME ZONE NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_anchor_attempts_id" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_anchor_attempts_batch" ON "anchor_attempts" ("batchId") `,
    );
    // The read this table exists for is "the latest attempts for this batch",
    // on both the pending-anchor backoff path and the operator health view.
    await queryRunner.query(
      `CREATE INDEX "ix_anchor_attempt_batch_time" ON "anchor_attempts" ("batchId", "occurredAt") `,
    );
    // CASCADE, not RESTRICT: an attempt has no meaning without its batch, and
    // keeping orphans would block a batch from ever being removed.
    await queryRunner.query(
      `ALTER TABLE "anchor_attempts" ADD CONSTRAINT "FK_anchor_attempts_batch" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "anchor_attempts" DROP CONSTRAINT "FK_anchor_attempts_batch"`,
    );
    await queryRunner.query(`DROP INDEX "public"."ix_anchor_attempt_batch_time"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_anchor_attempts_batch"`);
    await queryRunner.query(`DROP TABLE "anchor_attempts"`);
  }
}
