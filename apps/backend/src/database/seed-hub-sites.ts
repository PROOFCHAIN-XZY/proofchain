import "reflect-metadata";
import { config as loadDotenv } from "dotenv";
loadDotenv();
import { AppDataSource } from "./data-source";
import { HubEntity } from "./entities";
import { HUB_LOCATIONS, findHubLocation, formatHubLocations } from "./hub-locations";

/**
 * Create a hub for each known pilot site, so a device has somewhere to switch to.
 *
 *   npm run hubs:sites                  # every site in the catalogue
 *   npm run hubs:sites -- lagos kano    # only these
 *   npm run hubs:sites -- --fence 500   # with a wider geofence
 *
 * Idempotent by hub code: re-running adds what is missing and leaves existing
 * hubs — including their coordinates and fences — untouched. A hub that has been
 * moved deliberately must not be dragged back to a city centre by a seed script.
 *
 * Development only. A hub in production is a real place with a real operator,
 * created through `POST /hubs` by someone who has been there; conjuring sixteen
 * of them from a city list would put unstaffed sites in front of collectors.
 */

/** Wide enough to stand somewhere in a city without knowing its exact yard. */
const DEFAULT_FENCE_M = 500;

function parseArgs(argv: readonly string[]): { keys: string[]; fenceM: number } {
  const keys: string[] = [];
  let fenceM = DEFAULT_FENCE_M;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--fence") {
      const value = Number(argv[i + 1]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`--fence needs a positive number, got: ${argv[i + 1] ?? "nothing"}`);
      }
      fenceM = Math.round(value);
      i += 1;
      continue;
    }
    keys.push(arg);
  }

  return { keys, fenceM };
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("refusing to bulk-create hubs in production");
  }

  const { keys, fenceM } = parseArgs(process.argv.slice(2));

  const sites = keys.length
    ? keys.map((key) => {
        const site = findHubLocation(key);
        if (!site) {
          throw new Error(`"${key}" is not a known site. Known sites:\n\n${formatHubLocations()}`);
        }
        return site;
      })
    : HUB_LOCATIONS;

  await AppDataSource.initialize();
  const hubs = AppDataSource.getRepository(HubEntity);

  let created = 0;
  for (const site of sites) {
    const code = `${site.key.slice(0, 3).toUpperCase()}-01`;

    const existing = await hubs.findOne({ where: { code } });
    if (existing) {
      console.log(`${code.padEnd(8)} exists — left alone (${existing.lat}, ${existing.lng})`);
      continue;
    }

    await hubs.save(
      hubs.create({
        code,
        name: `${site.name} Hub`,
        lat: site.lat,
        lng: site.lng,
        geofenceRadiusM: fenceM,
        minWeightKg: 0.5,
        maxWeightKg: 200,
      }),
    );
    created += 1;
    console.log(`${code.padEnd(8)} created — ${site.name} (${site.country}) fence ${fenceM} m`);
  }

  console.log(`\n${created} hub(s) created, ${sites.length - created} already present`);
  if (created > 0) {
    console.log("Re-enrol the capture device so it picks up the new hub list.");
    console.log("Coordinates are city-centre approximations — set real ones with hub:relocate.");
  }

  await AppDataSource.destroy();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
