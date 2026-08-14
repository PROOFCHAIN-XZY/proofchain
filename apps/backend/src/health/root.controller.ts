import { Controller, Get, Res } from "@nestjs/common";
import type { Response } from "express";
import { ApiExcludeEndpoint, ApiTags } from "@nestjs/swagger";
import { Public } from "../auth/auth.module";
import { loadConfig } from "../config/configuration";

/**
 * Index route for `/`.
 *
 * Nest answers an unrouted path with a bare `Cannot GET /`, which reads like a
 * broken deployment to anyone opening the base URL. Every real endpoint is
 * namespaced (`/health`, `/auth/login`, `/batches`, …), so the root is
 * otherwise permanently empty.
 *
 * In development it forwards to the Swagger UI, because `/` is where a
 * forwarded port or a bare host name lands you and the docs are what you came
 * for. In production `main.ts` never mounts `/docs`, so redirecting there would
 * send visitors to a 404; that case returns a minimal JSON identity instead.
 *
 * Deliberately says nothing about configuration or state — it is `@Public()`,
 * so anything returned here is world-readable.
 */
@ApiTags("health")
@Controller()
export class RootController {
  /** Matches the condition guarding SwaggerModule.setup() in main.ts. */
  private readonly docsMounted = loadConfig().nodeEnv !== "production";

  @Public()
  // The response shape depends on the environment and the redirect target is
  // the docs themselves, so there is nothing useful to document here.
  @ApiExcludeEndpoint()
  @Get()
  index(@Res() res: Response): void {
    if (this.docsMounted) {
      // 302, not 301: a permanent redirect would be cached by the browser and
      // keep firing after someone disables the docs, leaving them stuck on a
      // 404 with no obvious cause.
      res.redirect(302, "/docs");
      return;
    }

    res.json({ service: "proofchain-api", health: "/health" });
  }
}
