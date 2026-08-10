import "reflect-metadata";
import { config as loadDotenv } from "dotenv";
loadDotenv();
import { AppDataSource } from "./data-source";
import { HubEntity } from "./entities";

/**
 * Move a hub to a given coordinate — a development convenience.
 *
 * The seed places its hub in Nairobi, which is correct for the pilot and useless
 * for anyone testing anywhere else: every captured weigh-in fails the geofence
 * because the collector is on another continent. Rather than have people edit the
 * seed (and quietly diverge from it), this moves the hub to where the tester is.
 *
 *   npm run hub:relocate -w @proofchain/backend -- <lat> <lng> [radiusM] [hubCode]
 *
 * Development only. In production a hub's coordinate is a claim about the
 * physical world that the geofence depends on, and moving it invalidates the
 * basis on which earlier weigh-ins at that hub were accepted.
 */
async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("refusing to relocate a hub in production");
  }

  const [latArg, lngArg, radiusArg, codeArg] = process.argv.slice(2);
  const lat = Number(latArg);
  const lng = Number(lngArg);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    throw new Error("usage: relocate-hub <lat> <lng> [radiusM] [hubCode]");
  }
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new Error(`coordinates out of range: ${lat}, ${lng}`);
  }

  await AppDataSource.initialize();
  const hubs = AppDataSource.getRepository(HubEntity);

  const hub = codeArg
    ? await hubs.findOne({ where: { code: codeArg } })
    : await hubs.findOne({ where: {}, order: { createdAt: "ASC" } });

  if (!hub) throw new Error(codeArg ? `no hub with code ${codeArg}` : "no hubs exist — run the seed first");

  const before = { lat: hub.lat, lng: hub.lng, radius: hub.geofenceRadiusM };
  hub.lat = lat;
  hub.lng = lng;
  if (radiusArg) {
    const radius = Number(radiusArg);
    if (!Number.isFinite(radius) || radius <= 0) throw new Error(`bad radius: ${radiusArg}`);
    hub.geofenceRadiusM = Math.round(radius);
  }

  await hubs.save(hub);

  console.log(`${hub.code} — ${hub.name}`);
  console.log(`  was: ${before.lat}, ${before.lng} (fence ${before.radius} m)`);
  console.log(`  now: ${hub.lat}, ${hub.lng} (fence ${hub.geofenceRadiusM} m)`);
  console.log("\nRe-enrol the capture device so it picks up the new hub coordinates.");

  await AppDataSource.destroy();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
