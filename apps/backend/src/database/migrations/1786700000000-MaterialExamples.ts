import { MigrationInterface, QueryRunner } from "typeorm";
import { SEED_MATERIALS } from "@proofchain/shared";

/**
 * Product examples on the material catalogue.
 *
 * The catalogue told a collector what a code meant in a sentence of prose. This
 * adds the list of things that sentence is about — "milk jugs", "bottle caps" —
 * so the capture apps can show what a material *is* rather than describe it, and
 * so an operator can correct the list when the local waste stream does not look
 * like the one the seed data was written for.
 *
 * Presentation only, exactly like `name` and `description`: nothing here is
 * signed, hashed, or anchored, and editing it cannot reach backwards into a
 * stored weigh-in. A separate migration rather than an edit to the Materials one
 * because that migration has already run against deployed databases.
 *
 * The backfill touches only the six seeded codes, and needs no guard against
 * overwriting an operator's work: the column does not exist until the statement
 * above it runs, so at that moment every row's list is the empty default and
 * there is nothing of anyone's to overwrite. A code an operator added themselves
 * keeps its empty list and is theirs to fill in from the dashboard.
 */
export class MaterialExamples1786700000000 implements MigrationInterface {
  name = "MaterialExamples1786700000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "materials"
      ADD COLUMN "examples" text[] NOT NULL DEFAULT '{}'
    `);

    for (const material of SEED_MATERIALS) {
      if (material.examples.length === 0) continue;

      await queryRunner.query(`UPDATE "materials" SET "examples" = $2 WHERE "code" = $1`, [
        material.code,
        material.examples,
      ]);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Dropping the column loses the operator's product lists and nothing else.
    // No event, batch or anchored root has ever referenced them.
    await queryRunner.query(`ALTER TABLE "materials" DROP COLUMN "examples"`);
  }
}
