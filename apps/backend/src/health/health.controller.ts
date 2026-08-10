import { Controller, Get } from "@nestjs/common";
import { InjectDataSource } from "@nestjs/typeorm";
import { DataSource } from "typeorm";
import { ApiTags } from "@nestjs/swagger";
import { Public } from "../auth/auth.module";

@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Public()
  @Get()
  async check() {
    // A health check that does not touch the database is a lie: the backend is
    // useless without Postgres, since Postgres is the source of truth.
    let database = "down";
    try {
      await this.dataSource.query("SELECT 1");
      database = "up";
    } catch {
      database = "down";
    }
    return {
      status: database === "up" ? "ok" : "degraded",
      database,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    };
  }
}
