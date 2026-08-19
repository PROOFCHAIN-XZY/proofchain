import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { MaterialsService } from "./materials.service";
import { Public, Roles } from "../auth/auth.module";
import { CreateMaterialDto, UpdateMaterialDto } from "../common/dto";

@ApiTags("materials")
@Controller("materials")
export class MaterialsController {
  constructor(private readonly materials: MaterialsService) {}

  /**
   * Public, because the capture apps need it and they hold no credentials — the
   * device signature is their only one, and it deliberately does not extend to
   * reading configuration. A capture app that could not fetch the catalogue would
   * be stuck with whatever list was compiled into it, which is the problem this
   * whole table exists to solve.
   *
   * Returns retired entries too, flagged. Callers filter on `active` for pickers
   * and use the full list to label history.
   */
  @Public()
  @Get()
  @ApiOperation({ summary: "The material catalogue, retired entries included and flagged" })
  list() {
    return this.materials.list();
  }

  /**
   * Admin, not operator. Adding a material mints a code that devices will sign
   * and that will be anchored on the ledger permanently — it is closer to a
   * schema change than to daily hub operation, and it belongs with the role that
   * already manages enrolment.
   */
  @Roles("admin")
  @Post()
  @ApiOperation({ summary: "Add a material. The code is permanent once signed." })
  create(@Body() dto: CreateMaterialDto) {
    return this.materials.create(dto);
  }

  /**
   * Rename, re-describe, reorder, retire or restore. There is no way to change a
   * code here, by design — see MaterialsService.
   */
  @Roles("admin")
  @Patch(":code")
  @ApiOperation({ summary: "Edit a material's presentation, or retire it with {active:false}" })
  update(@Param("code") code: string, @Body() dto: UpdateMaterialDto) {
    return this.materials.update(code, dto);
  }

  /**
   * Only ever succeeds for a code no event and no batch has used. Anything else
   * is a 409 pointing at retirement instead.
   */
  @Roles("admin")
  @Delete(":code")
  @ApiOperation({ summary: "Delete an unused material. Used ones must be retired instead." })
  remove(@Param("code") code: string) {
    return this.materials.remove(code);
  }
}
