import "reflect-metadata";
import { config as loadDotenv } from "dotenv";

loadDotenv();

import { Logger, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { loadConfig } from "./config/configuration";
import { isAllowedOrigin } from "./config/cors.js";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = new Logger("bootstrap");
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  app.use(helmet());

  // Production honours the allowlist alone; development additionally accepts
  // loopback and private-network origins so the capture PWA can be exercised
  // from a real phone. See config/cors.ts for why that distinction exists.
  const isProduction = config.nodeEnv === "production";
  app.enableCors({
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin ?? undefined, config.corsOrigins, isProduction)) {
        callback(null, true);
        return;
      }
      // Logged, because the browser only ever shows the operator "Failed to
      // fetch" — without this line the cause is invisible on both sides.
      logger.warn(`blocked cross-origin request from ${origin}`);
      callback(null, false);
    },
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      // Reject unknown fields outright: a device sending extra keys is either a
      // version mismatch or an attempt to smuggle unsigned data past us.
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );

  if (config.nodeEnv !== "production") {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle("ProofChain API")
        .setDescription("Verified waste-to-credit platform — MVP (Stellar testnet)")
        .setVersion("0.1.0")
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup("docs", app, doc);
  }

  app.enableShutdownHooks();

  await app.listen(config.port, "0.0.0.0");
  new Logger("bootstrap").log(
    `ProofChain API listening on :${config.port} (${config.nodeEnv}) — docs at /docs`,
  );
}

void bootstrap();
