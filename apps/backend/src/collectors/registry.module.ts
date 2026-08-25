import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { CollectorEntity, DeviceEntity, HubEntity } from "../database/entities";
import { RegistryService } from "./registry.service";
import { RegistryController } from "./registry.controller";

@Module({
  imports: [TypeOrmModule.forFeature([CollectorEntity, DeviceEntity, HubEntity])],
  controllers: [RegistryController],
  providers: [RegistryService],
  exports: [RegistryService],
})
export class RegistryModule {}
