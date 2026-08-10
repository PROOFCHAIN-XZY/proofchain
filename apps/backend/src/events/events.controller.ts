import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { EventsService } from "./events.service";
import { Public } from "../auth/auth.module";
import { ListEventsQueryDto, SubmitWeighInDto } from "../common/dto";
import { RateLimit } from "../common/rate-limit.guard";

@ApiTags("events")
@Controller("events")
export class EventsController {
  constructor(private readonly events: EventsService) {}

  /**
   * Device ingest. Public by design: authentication here IS the ed25519
   * signature over the payload, checked against the enrolled device key. A
   * bearer token on a shared field phone would be the weaker control, and it
   * would break the offline queue (tokens expire while a device is offline).
   */
  @Public()
  // A single honest device sends a handful of weigh-ins an hour; 60/min per
  // IP comfortably covers a hub with many phones sharing one NAT address
  // while still bounding how hard an attacker can hammer the ingest path.
  @RateLimit(60, 60)
  @Post()
  @ApiOperation({ summary: "Submit a signed weigh-in from a collector device" })
  submit(@Body() dto: SubmitWeighInDto) {
    return this.events.ingest(dto.payload, dto.signature);
  }

  @Get()
  list(@Query() query: ListEventsQueryDto) {
    return this.events.list(query);
  }

  @Get(":id")
  findOne(@Param("id", ParseUUIDPipe) id: string) {
    return this.events.findOne(id);
  }
}
