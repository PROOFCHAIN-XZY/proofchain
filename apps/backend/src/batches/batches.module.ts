import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import {
  AnchorAttemptEntity,
  AnchorRecordEntity,
  BatchEntity,
  CollectionEventEntity,
} from "../database/entities";
import { AnchorAttemptsService } from "./anchor-attempts.service";
import { BatchesService } from "./batches.service";
import { BatchesController } from "./batches.controller";
import { AuthModule } from "../auth/auth.module";
import { LedgerModule } from "../ledger/ledger.module";
import { MaterialsModule } from "../materials/materials.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([
      BatchEntity,
      CollectionEventEntity,
      AnchorRecordEntity,
      AnchorAttemptEntity,
    ]),
    // Needed for AnchorWorkerGuard, which protects POST :id/anchor.
    AuthModule,
    // Verification reads the anchor back off Horizon before reporting it.
    LedgerModule,
    // Opening a batch requires a material that is in the catalogue and active.
    MaterialsModule,
  ],
  controllers: [BatchesController],
  providers: [BatchesService, AnchorAttemptsService],
  exports: [BatchesService, AnchorAttemptsService],
})
export class BatchesModule {}
