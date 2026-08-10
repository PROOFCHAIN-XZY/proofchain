import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { CustodyService } from "./custody.service";
import { Roles } from "../auth/auth.module";
import { CreateCustodyTransferDto } from "../common/dto";

@ApiTags("custody")
@Controller("batches/:batchId/custody")
export class CustodyController {
  constructor(private readonly custody: CustodyService) {}

  @Get()
  list(@Param("batchId", ParseUUIDPipe) batchId: string) {
    return this.custody.list(batchId);
  }

  @Roles("admin", "operator")
  @Post()
  create(
    @Param("batchId", ParseUUIDPipe) batchId: string,
    @Body() dto: CreateCustodyTransferDto,
  ) {
    return this.custody.create(batchId, dto);
  }
}
