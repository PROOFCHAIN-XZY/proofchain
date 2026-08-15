import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1786190303177 implements MigrationInterface {
    name = 'InitialSchema1786190303177'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // Every table below defaults its primary key to uuid_generate_v4(), which
        // lives in uuid-ossp and is NOT installed in a stock Postgres. Without
        // this line the very first CREATE TABLE fails with "function
        // uuid_generate_v4() does not exist" on any database nobody has prepared
        // by hand — a fresh Neon branch, a CI service container, a new clone.
        // IF NOT EXISTS keeps it a no-op on databases where it was created
        // manually before this line existed.
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`);
        await queryRunner.query(`CREATE TABLE "hubs" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "code" character varying NOT NULL, "name" character varying NOT NULL, "lat" double precision NOT NULL, "lng" double precision NOT NULL, "geofenceRadiusM" integer NOT NULL DEFAULT '250', "minWeightKg" numeric(10,3) NOT NULL DEFAULT '0.1', "maxWeightKg" numeric(10,3) NOT NULL DEFAULT '500', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_a5b22a077572b2ebcff8be166e2" UNIQUE ("code"), CONSTRAINT "PK_44b53d1f2b4568b26ce4710b843" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "collectors" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "name" character varying NOT NULL, "phone" character varying NOT NULL, "cooperativeId" character varying, "kycLevel" character varying NOT NULL DEFAULT 'none', "homeLat" double precision, "homeLng" double precision, "active" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_9ee574b062d157712d9db3f9030" UNIQUE ("phone"), CONSTRAINT "PK_da4185226ea730100d5aa647afe" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE TABLE "devices" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "collectorId" uuid NOT NULL, "label" character varying NOT NULL, "publicKeyBase64" character varying NOT NULL, "enrolledAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "revokedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "UQ_b14fbd21744d3c9fcf8744f1af1" UNIQUE ("publicKeyBase64"), CONSTRAINT "PK_b1514758245c12daf43486dd1f0" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_9e239a529c1cbfd1478d66b3af" ON "devices" ("collectorId") `);
        await queryRunner.query(`CREATE TABLE "batches" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "hubId" uuid NOT NULL, "material" character varying NOT NULL, "status" character varying NOT NULL DEFAULT 'open', "totalWeightKg" numeric(12,3) NOT NULL DEFAULT '0', "eventCount" integer NOT NULL DEFAULT '0', "merkleRoot" character varying, "sealedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_55e7ff646e969b61d37eea5be7a" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_61812ea23f91f1c115b7f557b3" ON "batches" ("hubId") `);
        await queryRunner.query(`CREATE INDEX "IDX_0e0a2fc0b05d1980725ce39725" ON "batches" ("status") `);
        await queryRunner.query(`CREATE TABLE "collection_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "collectorId" uuid NOT NULL, "hubId" uuid NOT NULL, "deviceId" uuid NOT NULL, "batchId" uuid, "weightKg" numeric(10,3) NOT NULL, "material" character varying NOT NULL, "lat" double precision NOT NULL, "lng" double precision NOT NULL, "capturedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "receivedAt" TIMESTAMP WITH TIME ZONE NOT NULL, "photoHash" character varying NOT NULL, "photoUri" character varying, "nonce" character varying NOT NULL, "signature" text NOT NULL, "payloadHash" character varying NOT NULL, "integrity" jsonb NOT NULL, "quarantined" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "uq_event_payload_hash" UNIQUE ("payloadHash"), CONSTRAINT "PK_638f9d42bfd752116448dbc4a88" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_ce0a607dfe2188ae3ddef0b21d" ON "collection_events" ("collectorId") `);
        await queryRunner.query(`CREATE INDEX "IDX_77fc45ec49525597333bff185c" ON "collection_events" ("hubId") `);
        await queryRunner.query(`CREATE INDEX "IDX_b45e3769b102217b4282f7dcda" ON "collection_events" ("deviceId") `);
        await queryRunner.query(`CREATE INDEX "IDX_57e9eb7a9a08c4bf4dd76b197c" ON "collection_events" ("batchId") `);
        await queryRunner.query(`CREATE INDEX "IDX_73b9ea617f53ccdb8634a76706" ON "collection_events" ("quarantined") `);
        await queryRunner.query(`CREATE INDEX "ix_event_hub_captured" ON "collection_events" ("hubId", "capturedAt") `);
        await queryRunner.query(`CREATE TABLE "custody_transfers" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "batchId" uuid NOT NULL, "fromParty" character varying NOT NULL, "toParty" character varying NOT NULL, "weightInKg" numeric(12,3) NOT NULL, "weightOutKg" numeric(12,3) NOT NULL, "varianceKg" numeric(12,3) NOT NULL, "reason" character varying, "transferredAt" TIMESTAMP WITH TIME ZONE NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_805d3ae7fbc3fcd72aa3fd07a3e" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_bbecdb558554542d63b9ceea5a" ON "custody_transfers" ("batchId") `);
        await queryRunner.query(`CREATE TABLE "anchor_records" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "batchId" uuid NOT NULL, "merkleRoot" character varying NOT NULL, "stellarTxHash" character varying NOT NULL, "stellarLedger" bigint NOT NULL, "network" character varying NOT NULL DEFAULT 'testnet', "dataEntryKey" character varying NOT NULL, "anchoredAt" TIMESTAMP WITH TIME ZONE NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_7dc14d551b125d295ba22b43582" UNIQUE ("stellarTxHash"), CONSTRAINT "REL_a71d181af4fad657dcd4b367e9" UNIQUE ("batchId"), CONSTRAINT "PK_b27ccac84fb6dd1a2b81c3d94fb" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_a71d181af4fad657dcd4b367e9" ON "anchor_records" ("batchId") `);
        await queryRunner.query(`CREATE TABLE "users" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "email" character varying NOT NULL, "passwordHash" text NOT NULL, "role" character varying NOT NULL DEFAULT 'operator', "active" boolean NOT NULL DEFAULT true, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_97672ac88f789774dd47f7c8be3" UNIQUE ("email"), CONSTRAINT "PK_a3ffb1c0c8416b9fc6f907b7433" PRIMARY KEY ("id"))`);
        await queryRunner.query(`ALTER TABLE "devices" ADD CONSTRAINT "FK_9e239a529c1cbfd1478d66b3af8" FOREIGN KEY ("collectorId") REFERENCES "collectors"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "batches" ADD CONSTRAINT "FK_61812ea23f91f1c115b7f557b3d" FOREIGN KEY ("hubId") REFERENCES "hubs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "collection_events" ADD CONSTRAINT "FK_ce0a607dfe2188ae3ddef0b21d9" FOREIGN KEY ("collectorId") REFERENCES "collectors"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "collection_events" ADD CONSTRAINT "FK_77fc45ec49525597333bff185c6" FOREIGN KEY ("hubId") REFERENCES "hubs"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "collection_events" ADD CONSTRAINT "FK_b45e3769b102217b4282f7dcda2" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "collection_events" ADD CONSTRAINT "FK_57e9eb7a9a08c4bf4dd76b197c6" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "custody_transfers" ADD CONSTRAINT "FK_bbecdb558554542d63b9ceea5ac" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "anchor_records" ADD CONSTRAINT "FK_a71d181af4fad657dcd4b367e9d" FOREIGN KEY ("batchId") REFERENCES "batches"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "anchor_records" DROP CONSTRAINT "FK_a71d181af4fad657dcd4b367e9d"`);
        await queryRunner.query(`ALTER TABLE "custody_transfers" DROP CONSTRAINT "FK_bbecdb558554542d63b9ceea5ac"`);
        await queryRunner.query(`ALTER TABLE "collection_events" DROP CONSTRAINT "FK_57e9eb7a9a08c4bf4dd76b197c6"`);
        await queryRunner.query(`ALTER TABLE "collection_events" DROP CONSTRAINT "FK_b45e3769b102217b4282f7dcda2"`);
        await queryRunner.query(`ALTER TABLE "collection_events" DROP CONSTRAINT "FK_77fc45ec49525597333bff185c6"`);
        await queryRunner.query(`ALTER TABLE "collection_events" DROP CONSTRAINT "FK_ce0a607dfe2188ae3ddef0b21d9"`);
        await queryRunner.query(`ALTER TABLE "batches" DROP CONSTRAINT "FK_61812ea23f91f1c115b7f557b3d"`);
        await queryRunner.query(`ALTER TABLE "devices" DROP CONSTRAINT "FK_9e239a529c1cbfd1478d66b3af8"`);
        await queryRunner.query(`DROP TABLE "users"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_a71d181af4fad657dcd4b367e9"`);
        await queryRunner.query(`DROP TABLE "anchor_records"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_bbecdb558554542d63b9ceea5a"`);
        await queryRunner.query(`DROP TABLE "custody_transfers"`);
        await queryRunner.query(`DROP INDEX "public"."ix_event_hub_captured"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_73b9ea617f53ccdb8634a76706"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_57e9eb7a9a08c4bf4dd76b197c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_b45e3769b102217b4282f7dcda"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_77fc45ec49525597333bff185c"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_ce0a607dfe2188ae3ddef0b21d"`);
        await queryRunner.query(`DROP TABLE "collection_events"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_0e0a2fc0b05d1980725ce39725"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_61812ea23f91f1c115b7f557b3"`);
        await queryRunner.query(`DROP TABLE "batches"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9e239a529c1cbfd1478d66b3af"`);
        await queryRunner.query(`DROP TABLE "devices"`);
        await queryRunner.query(`DROP TABLE "collectors"`);
        await queryRunner.query(`DROP TABLE "hubs"`);
        // The uuid-ossp extension is deliberately left in place. It is
        // database-wide, not owned by this schema, and dropping it would break
        // anything else in the same database that depends on it.
    }

}
