import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { CollectionEventEntity } from "../database/entities";
import { PhotoStore } from "./photo-store";
import { PhotosService } from "./photos.service";
import { PhotosController } from "./photos.controller";

/**
 * Photo evidence, kept out of EventsModule on purpose.
 *
 * Ingest must stay small and fast — it is the path a field phone retries on a
 * bad link — while this module owns filesystem access and multi-megabyte
 * bodies. Separating them keeps the storage root from becoming a dependency of
 * accepting a weigh-in at all.
 */
@Module({
  imports: [TypeOrmModule.forFeature([CollectionEventEntity])],
  controllers: [PhotosController],
  providers: [PhotoStore, PhotosService],
  exports: [PhotosService, PhotoStore],
})
export class PhotosModule {}
