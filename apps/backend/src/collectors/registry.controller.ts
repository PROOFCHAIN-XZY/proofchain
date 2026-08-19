import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { RegistryService } from "./registry.service";
import { Public, Roles } from "../auth/auth.module";
import { CreateCollectorDto, CreateHubDto, EnrolDeviceDto } from "../common/dto";

@ApiTags("registry")
@Controller()
export class RegistryController {
  constructor(private readonly registry: RegistryService) {}

  @Get("collectors")
  listCollectors() {
    return this.registry.listCollectors();
  }

  @Roles("admin", "operator")
  @Post("collectors")
  createCollector(@Body() dto: CreateCollectorDto) {
    return this.registry.createCollector(dto);
  }

  @Get("devices")
  listDevices(@Query("collectorId") collectorId?: string) {
    return this.registry.listDevices(collectorId);
  }

  @Roles("admin", "operator")
  @Post("devices")
  enrolDevice(@Body() dto: EnrolDeviceDto) {
    return this.registry.enrolDevice(dto);
  }

  @Roles("admin", "operator")
  @Delete("devices/:id")
  revokeDevice(@Param("id", ParseUUIDPipe) id: string) {
    return this.registry.revokeDevice(id);
  }

  @Get("hubs")
  listHubs() {
    return this.registry.listHubs();
  }

  /**
   * Public for the same reason the material catalogue is: a capture device holds
   * no credentials, and it cannot warn a collector that a fix falls outside a
   * geofence without knowing where the hubs are. Declared before nothing else
   * matches "hubs/..." so ordering is not a concern here.
   */
  @Public()
  @Get("hubs/directory")
  @ApiOperation({ summary: "Hub coordinates and geofences, for capture devices" })
  hubDirectory() {
    return this.registry.hubDirectory();
  }

  @Roles("admin")
  @Post("hubs")
  createHub(@Body() dto: CreateHubDto) {
    return this.registry.createHub(dto);
  }
}
