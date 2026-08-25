import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  CollectionEventEntity,
  CollectorEntity,
  DeviceEntity,
  HubEntity,
} from "../database/entities";
import { EventsService } from "./events.service";
import { EventsController } from "./events.controller";
import { MaterialsModule } from "../materials/materials.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([CollectionEventEntity, DeviceEntity, CollectorEntity, HubEntity]),
    // Ingest refuses a material the catalogue has never defined.
    MaterialsModule,
  ],
  controllers: [EventsController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
