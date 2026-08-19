import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * A human place name on each hub, for reports.
 *
 * Additive and nullable, so this is safe to apply to a database already holding
 * anchored batches: existing hubs simply have no label until the backfill script
 * is run, and a null label renders as coordinates alone — which is what every
 * report showed before this migration.
 *
 * Nothing in the integrity, sealing or verification path reads these columns.
 * They are presentation metadata; the proof continues to rest on lat/lng.
 */
export class HubLocality1786500000000 implements MigrationInterface {
  name = "HubLocality1786500000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "hubs" ADD "locality" character varying(200)`);
    await queryRunner.query(`ALTER TABLE "hubs" ADD "localityResolvedAt" TIMESTAMP WITH TIME ZONE`);
    await queryRunner.query(`ALTER TABLE "hubs" ADD "localityAttribution" character varying(300)`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "hubs" DROP COLUMN "localityAttribution"`);
    await queryRunner.query(`ALTER TABLE "hubs" DROP COLUMN "localityResolvedAt"`);
    await queryRunner.query(`ALTER TABLE "hubs" DROP COLUMN "locality"`);
  }
}
