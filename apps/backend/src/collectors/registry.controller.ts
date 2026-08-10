import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { RegistryService } from "./registry.service";
import { Roles } from "../auth/auth.module";
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

  @Roles("admin")
  @Post("hubs")
  createHub(@Body() dto: CreateHubDto) {
    return this.registry.createHub(dto);
  }
}
