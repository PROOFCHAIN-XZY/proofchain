import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { BatchEntity, CollectionEventEntity, MaterialEntity } from "../database/entities";
import { MaterialsController } from "./materials.controller";
import { MaterialsService } from "./materials.service";
import { AuthModule } from "../auth/auth.module";

/**
 * Events and batches are read-only here, and only to count references before
 * allowing a delete. Nothing in this module writes to them.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([MaterialEntity, CollectionEventEntity, BatchEntity]),
    AuthModule,
  ],
  controllers: [MaterialsController],
  providers: [MaterialsService],
  exports: [MaterialsService],
})
export class MaterialsModule {}
