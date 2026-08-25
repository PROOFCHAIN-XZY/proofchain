import { MigrationInterface, QueryRunner } from "typeorm";
import { SEED_MATERIALS } from "@proofchain/shared";

/**
 * The material catalogue, moved from a compiled constant into a table an
 * operator maintains.
 *
 * Safe to apply to a database already holding anchored batches. The table is new
 * and nothing references it: `collection_events.material` and `batches.material`
 * keep storing the code as a plain varchar, with no foreign key added. That is a
 * decision, not an omission — a signed material code is a historical fact, and
 * making it a reference to a mutable configuration row would let a catalogue edit
 * reach backwards into evidence.
 *
 * The six codes the pilot shipped with are seeded here so that no deployment ever
 * has an empty picker, and so that events already in the database refer to codes
 * the catalogue knows about. `ON CONFLICT DO NOTHING` keeps this idempotent
 * against a database where an operator has already created one of them.
 */
export class Materials1786600000000 implements MigrationInterface {
  name = "Materials1786600000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "materials" (
        "code" character varying(16) NOT NULL,
        "name" character varying(120) NOT NULL,
        "description" character varying(300),
        "active" boolean NOT NULL DEFAULT true,
        "sortOrder" integer NOT NULL DEFAULT 100,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_materials_code" PRIMARY KEY ("code")
      )
    `);

    // Enforced in the database as well as in the DTO. A code reaches the signed
    // payload and the ledger, so a lowercase or space-bearing code getting in
    // through a future script that bypasses validation would be permanent.
    await queryRunner.query(`
      ALTER TABLE "materials"
      ADD CONSTRAINT "CHK_materials_code_shape"
      CHECK ("code" ~ '^[A-Z0-9][A-Z0-9_-]{1,15}$')
    `);

    // Partial index: the pickers only ever query active rows, and this is the
    // one query on the hot capture path.
    await queryRunner.query(`
      CREATE INDEX "IDX_materials_active" ON "materials" ("sortOrder", "code")
      WHERE "active"
    `);

    for (const material of SEED_MATERIALS) {
      await queryRunner.query(
        `INSERT INTO "materials" ("code", "name", "description", "active", "sortOrder")
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT ("code") DO NOTHING`,
        [material.code, material.name, material.description, material.active, material.sortOrder],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Dropping the catalogue does not touch a single event or batch — their
    // material codes are plain strings, which is exactly the point of having no
    // foreign key. A rollback loses the operator's names and retirements, not
    // any evidence.
    await queryRunner.query(`DROP INDEX "IDX_materials_active"`);
    await queryRunner.query(`DROP TABLE "materials"`);
  }
}
