import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiSecurity, ApiTags } from "@nestjs/swagger";
import { BatchesService } from "./batches.service";
import { AnchorWorkerGuard, Public, Roles } from "../auth/auth.module";
import {
  AddEventsDto,
  AdvanceStatusDto,
  CreateBatchDto,
  RecordAnchorDto,
  RecordAnchorFailureDto,
} from "../common/dto";
import type { BatchStatus } from "@proofchain/shared";

@ApiTags("batches")
@Controller("batches")
export class BatchesController {
  constructor(private readonly batches: BatchesService) {}

  @Get()
  list(@Query("status") status?: BatchStatus) {
    return this.batches.list(status);
  }

  @Roles("admin", "operator")
  @Post()
  create(@Body() dto: CreateBatchDto) {
    return this.batches.create(dto.hubId, dto.material);
  }

  /**
   * Declared before ":id" so the literal path is not swallowed by the UUID
   * route. Public so the anchor worker can poll without holding a user token.
   */
  @Public()
  @Get("pending-anchor")
  @ApiOperation({ summary: "Sealed batches with no on-chain anchor yet" })
  pendingAnchor() {
    return this.batches.pendingAnchor();
  }

  @Get(":id")
  findOne(@Param("id", ParseUUIDPipe) id: string) {
    return this.batches.findOne(id);
  }

  @Get(":id/events")
  events(@Param("id", ParseUUIDPipe) id: string) {
    return this.batches.eventsOf(id);
  }

  @Roles("admin", "operator")
  @Post(":id/events")
  addEvents(@Param("id", ParseUUIDPipe) id: string, @Body() dto: AddEventsDto) {
    return this.batches.addEvents(id, dto.eventIds);
  }

  @Roles("admin", "operator")
  @Delete(":id/events/:eventId")
  removeEvent(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("eventId", ParseUUIDPipe) eventId: string,
  ) {
    return this.batches.removeEvent(id, eventId);
  }

  @Roles("admin", "operator")
  @Post(":id/seal")
  @ApiOperation({ summary: "Freeze membership and compute the Merkle root" })
  seal(@Param("id", ParseUUIDPipe) id: string) {
    return this.batches.seal(id);
  }

  @Roles("admin", "operator")
  @Post(":id/status")
  advance(@Param("id", ParseUUIDPipe) id: string, @Body() dto: AdvanceStatusDto) {
    return this.batches.advanceStatus(id, dto.status);
  }

  /**
   * `@Public()` only opts this out of the *human* JWT guard — the anchor
   * worker is a headless service, not an operator with a login session. It is
   * NOT open to the internet: `AnchorWorkerGuard` requires the shared
   * `x-anchor-worker-token` credential. Without that guard, anyone who reads
   * a batch's merkleRoot off the public audit report (`GET
   * /batches/:id/report`) could forge a Stellar tx hash and have it recorded
   * as this batch's on-chain proof.
   */
  @Public()
  @UseGuards(AnchorWorkerGuard)
  @ApiSecurity("anchor-worker-token")
  @Post(":id/anchor")
  @ApiOperation({ summary: "Anchor worker writes back the Stellar transaction" })
  recordAnchor(@Param("id", ParseUUIDPipe) id: string, @Body() dto: RecordAnchorDto) {
    return this.batches.recordAnchor(id, dto);
  }

  /**
   * The worker reporting that an attempt produced no anchor.
   *
   * Guarded by the same shared token as the anchor write-back, and for a
   * sharper reason: an anonymous caller able to post failures could park every
   * sealed batch in maximum backoff and stop anchoring altogether, quietly,
   * while the pipeline continued to look merely slow.
   */
  @Public()
  @UseGuards(AnchorWorkerGuard)
  @ApiSecurity("anchor-worker-token")
  @Post(":id/anchor-failure")
  @ApiOperation({ summary: "Anchor worker reports an attempt that produced no anchor" })
  recordAnchorFailure(@Param("id", ParseUUIDPipe) id: string, @Body() dto: RecordAnchorFailureDto) {
    return this.batches.recordAnchorFailure(id, dto);
  }

  /**
   * Public for the same reason the proof endpoint is: an auditor must be able
   * to check the anchor without an account here. Separate from the per-event
   * proof so checking a hundred events costs one Horizon read, not a hundred.
   */
  @Public()
  @Get(":id/ledger")
  @ApiOperation({ summary: "Re-read this batch's anchor off the Stellar ledger" })
  ledger(@Param("id", ParseUUIDPipe) id: string) {
    return this.batches.ledgerStatus(id);
  }

  /** Open to anyone holding the ids: verification must not require our blessing. */
  @Public()
  @Get(":batchId/verify/:eventId")
  @ApiOperation({ summary: "Merkle proof for one event against the anchored root" })
  verify(
    @Param("batchId", ParseUUIDPipe) batchId: string,
    @Param("eventId", ParseUUIDPipe) eventId: string,
  ) {
    return this.batches.verifyEvent(batchId, eventId);
  }
}
