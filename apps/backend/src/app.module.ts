import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { ConfigModule } from "@nestjs/config";
import { TypeOrmModule } from "@nestjs/typeorm";
import { ALL_ENTITIES } from "./database/entities";
import { loadConfig } from "./config/configuration";
import { AuthModule, JwtAuthGuard } from "./auth/auth.module";
import { AuthController } from "./auth/auth.controller";
import { HealthController } from "./health/health.controller";
import { RootController } from "./health/root.controller";
import { RegistryModule } from "./collectors/registry.module";
import { EventsModule } from "./events/events.module";
import { PhotosModule } from "./photos/photos.module";
import { BatchesModule } from "./batches/batches.module";
import { CustodyModule } from "./custody/custody.module";
import { ReportsModule } from "./reports/reports.module";
import { RateLimitGuard } from "./common/rate-limit.guard";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [loadConfig] }),
    TypeOrmModule.forRootAsync({
      useFactory: () => {
        const config = loadConfig();
        return {
          type: "postgres" as const,
          url: config.databaseUrl,
          entities: ALL_ENTITIES,
          migrations: [`${__dirname}/database/migrations/*.{ts,js}`],
          // Never synchronize: this database is the evidentiary record behind
          // saleable credits, so schema changes go through reviewed migrations.
          synchronize: false,
          migrationsRun: false,
          logging: process.env.TYPEORM_LOGGING === "true",
        };
      },
    }),
    AuthModule,
    RegistryModule,
    EventsModule,
    PhotosModule,
    BatchesModule,
    CustodyModule,
    ReportsModule,
  ],
  controllers: [RootController, AuthController, HealthController],
  providers: [
    // Authentication is on by default; routes opt out with @Public().
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Opt-in per route via @RateLimit(...); a no-op everywhere else.
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class AppModule {}
