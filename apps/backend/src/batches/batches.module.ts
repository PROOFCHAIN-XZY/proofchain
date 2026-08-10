import { Module } from "@nestjs/common";
import { TypeOrmModule } from "@nestjs/typeorm";
import { AnchorRecordEntity, BatchEntity, CollectionEventEntity } from "../database/entities";
import { BatchesService } from "./batches.service";
import { BatchesController } from "./batches.controller";
import { AuthModule } from "../auth/auth.module";

@Module({
  imports: [
    TypeOrmModule.forFeature([BatchEntity, CollectionEventEntity, AnchorRecordEntity]),
    // Needed for AnchorWorkerGuard, which protects POST :id/anchor.
    AuthModule,
  ],
  controllers: [BatchesController],
  providers: [BatchesService],
  exports: [BatchesService],
})
export class BatchesModule {}
