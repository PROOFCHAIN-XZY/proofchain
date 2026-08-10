import { Controller, Get, Header, Param, ParseUUIDPipe, Res } from "@nestjs/common";
import type { Response } from "express";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { ReportsService } from "./reports.service";
import { Public } from "../auth/auth.module";

@ApiTags("reports")
@Controller("batches/:batchId/report")
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /**
   * Public: the whole point is that a buyer or verifier can check our claims
   * without an account with us. The report contains no personal data beyond
   * collector names already disclosed in the chain of custody.
   */
  @Public()
  @Get()
  @ApiOperation({ summary: "The audit artifact for a batch (JSON)" })
  json(@Param("batchId", ParseUUIDPipe) batchId: string) {
    return this.reports.buildAuditReport(batchId);
  }

  @Public()
  @Get("events.csv")
  @Header("Content-Type", "text/csv; charset=utf-8")
  async csv(@Param("batchId", ParseUUIDPipe) batchId: string, @Res() res: Response) {
    const csv = await this.reports.buildEventCsv(batchId);
    res.setHeader("Content-Disposition", `attachment; filename="proofchain-${batchId}.csv"`);
    res.send(csv);
  }
}
