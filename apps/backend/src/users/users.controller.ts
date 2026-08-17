import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { UsersService } from "./users.service";
import { CurrentUser, Roles, type JwtPayload } from "../auth/auth.module";
import { CreateUserDto, ResetPasswordDto, UpdateUserDto } from "../common/dto";

/**
 * Admin-only account management. Every route here inherits the global
 * `JwtAuthGuard`; `@Roles("admin")` narrows it further, because the ability to
 * mint an operator account is the ability to add events to batches.
 */
@ApiTags("users")
@Roles("admin")
@Controller("users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  list() {
    return this.users.list();
  }

  @Post()
  @ApiOperation({ summary: "Create an operator, auditor or admin account" })
  create(@Body() dto: CreateUserDto) {
    return this.users.create(dto);
  }

  @Get(":id")
  findOne(@Param("id", ParseUUIDPipe) id: string) {
    return this.users.findOne(id);
  }

  @Patch(":id")
  @ApiOperation({ summary: "Change a user's role, or deactivate them" })
  update(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
    @CurrentUser() actor: JwtPayload,
  ) {
    return this.users.update(id, dto, actor);
  }

  @Post(":id/password")
  @ApiOperation({ summary: "Reset another user's password (hand it over out of band)" })
  resetPassword(@Param("id", ParseUUIDPipe) id: string, @Body() dto: ResetPasswordDto) {
    return this.users.resetPassword(id, dto.newPassword);
  }
}
