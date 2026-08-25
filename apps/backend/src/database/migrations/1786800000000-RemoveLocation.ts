import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Removes all captured location data from the schema.
 *
 * This is destructive and one-way in the sense that matters: `collection_events.lat`
 * and `collection_events.lng` were part of the canonical signed payload under
 * `proofchain.weighin.v1`, so dropping them makes every signature and every
 * Merkle root recorded before this migration impossible to recompute. Batches
 * already anchored on Stellar keep their transaction, but the root can no
 * longer be re-derived from the event rows, and audit reports issued earlier
 * will not re-verify.
 *
 * The `down()` restores the columns so the schema shape can be rolled back, but
 * it cannot restore the values — the coordinates are gone, and with them the
 * ability to reproduce any pre-v2 signature. Rolling back leaves nulls.
 *
 * The geofence check (`geofence_ok`) is removed from integrity v1 by the same
 * change: with no coordinate on the payload there is nothing to fence.
 */
export class RemoveLocation1786800000000 implements MigrationInterface {
  name = "RemoveLocation1786800000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "collection_events" DROP COLUMN "lat"`);
    await queryRunner.query(`ALTER TABLE "collection_events" DROP COLUMN "lng"`);

    await queryRunner.query(`ALTER TABLE "hubs" DROP COLUMN "lat"`);
    await queryRunner.query(`ALTER TABLE "hubs" DROP COLUMN "lng"`);
    await queryRunner.query(`ALTER TABLE "hubs" DROP COLUMN "geofenceRadiusM"`);
    await queryRunner.query(`ALTER TABLE "hubs" DROP COLUMN "locality"`);
    await queryRunner.query(`ALTER TABLE "hubs" DROP COLUMN "localityResolvedAt"`);
    await queryRunner.query(`ALTER TABLE "hubs" DROP COLUMN "localityAttribution"`);

    await queryRunner.query(`ALTER TABLE "collectors" DROP COLUMN "homeLat"`);
    await queryRunner.query(`ALTER TABLE "collectors" DROP COLUMN "homeLng"`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "collectors" ADD "homeLng" double precision`);
    await queryRunner.query(`ALTER TABLE "collectors" ADD "homeLat" double precision`);

    await queryRunner.query(`ALTER TABLE "hubs" ADD "localityAttribution" character varying(300)`);
    await queryRunner.query(`ALTER TABLE "hubs" ADD "localityResolvedAt" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "hubs" ADD "locality" character varying(200)`);
    await queryRunner.query(`ALTER TABLE "hubs" ADD "geofenceRadiusM" integer NOT NULL DEFAULT 250`);
    await queryRunner.query(`ALTER TABLE "hubs" ADD "lng" double precision NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "hubs" ADD "lat" double precision NOT NULL DEFAULT 0`);

    await queryRunner.query(`ALTER TABLE "collection_events" ADD "lng" double precision NOT NULL DEFAULT 0`);
    await queryRunner.query(`ALTER TABLE "collection_events" ADD "lat" double precision NOT NULL DEFAULT 0`);
  }
}
