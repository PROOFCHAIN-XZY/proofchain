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

@Module({
  imports: [
    TypeOrmModule.forFeature([CollectionEventEntity, DeviceEntity, CollectorEntity, HubEntity]),
  ],
  controllers: [EventsController],
  providers: [EventsService],
  exports: [EventsService],
})
export class EventsModule {}
