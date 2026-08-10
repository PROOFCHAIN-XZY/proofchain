import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { AuthService, Public } from "./auth.module";
import { LoginDto } from "../common/dto";
import { RateLimit } from "../common/rate-limit.guard";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  // Timing-safe comparison in AuthService stops user enumeration, not brute
  // force; this bounds how many password guesses an attacker gets per IP.
  @RateLimit(10, 60)
  @Post("login")
  @HttpCode(200)
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto.email, dto.password);
  }
}
