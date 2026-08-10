import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { BatchEntity, CustodyTransferEntity } from "../database/entities";
import { CustodyService } from "./custody.service";
import { CustodyController } from "./custody.controller";

@Module({
  imports: [TypeOrmModule.forFeature([CustodyTransferEntity, BatchEntity])],
  controllers: [CustodyController],
  providers: [CustodyService],
  exports: [CustodyService],
})
export class CustodyModule {}
