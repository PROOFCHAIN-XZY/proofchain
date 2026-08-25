import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Raises the per-weigh-in ceiling from 500 kg to 10 tonnes.
 *
 * The old ceiling encoded an assumption that stopped being true: that a
 * weigh-in is what one collector carries to a hand scale. A hub that weighs an
 * aggregated delivery — a full sack run, a truck bed — exceeds 500 kg routinely,
 * and every one of those was quarantined at ingest as `weight_in_range`. The
 * check itself is still worth having; only its default figure was wrong.
 *
 * Existing rows are raised too, not just the column default. A migration that
 * changed only the default would leave every hub already in the database on the
 * old ceiling, which is exactly the state that produced the rejections — and the
 * only way to fix it would be hand-written SQL per deployment, since there is no
 * endpoint to update a hub.
 *
 * `up()` deliberately does not touch a hub whose ceiling is already above
 * 10 tonnes: an operator who set a higher one meant it, and this migration is
 * raising a floor under everybody, not imposing a number.
 *
 * `down()` restores the previous column default but leaves the data. The
 * per-hub figures it replaced are not recorded anywhere, and inventing 500 kg
 * for hubs that never had it would be worse than leaving the ceiling high — a
 * ceiling that is too high quarantines nothing; one that is too low quarantines
 * honest work.
 *
 * Events already quarantined for weight are NOT revived. Quarantine is a
 * property of the verdict recorded at ingest, and rewriting a stored integrity
 * verdict after the fact would make the audit trail describe checks that never
 * ran that way. Those weigh-ins must be re-captured, which is precisely why the
 * capture apps now hold the hub's bounds and refuse an over-limit weight before
 * it is signed.
 */
export class HubWeightCeiling1786900000000 implements MigrationInterface {
  name = "HubWeightCeiling1786900000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "hubs" ALTER COLUMN "maxWeightKg" SET DEFAULT '10000'`,
    );
    await queryRunner.query(
      `UPDATE "hubs" SET "maxWeightKg" = 10000 WHERE "maxWeightKg" < 10000`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "hubs" ALTER COLUMN "maxWeightKg" SET DEFAULT '500'`);
  }
}
