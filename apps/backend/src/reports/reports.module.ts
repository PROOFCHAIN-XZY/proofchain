import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { LedgerModule } from "../ledger/ledger.module";
import {
  AnchorRecordEntity,
  BatchEntity,
  CollectionEventEntity,
  CollectorEntity,
  CustodyTransferEntity,
  HubEntity,
} from "../database/entities";
import { ReportsService } from "./reports.service";
import { ReportsController } from "./reports.controller";

@Module({
  imports: [
    // The report re-reads its anchor off Horizon before publishing it.
    LedgerModule,
    TypeOrmModule.forFeature([
      BatchEntity,
      CollectionEventEntity,
      CustodyTransferEntity,
      CollectorEntity,
      HubEntity,
      AnchorRecordEntity,
    ]),
  ],
  controllers: [ReportsController],
  providers: [ReportsService],
  exports: [ReportsService],
})
export class ReportsModule {}
