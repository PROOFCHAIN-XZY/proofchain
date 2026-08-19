import "reflect-metadata";
import { config as loadDotenv } from "dotenv";
loadDotenv();
import { AppDataSource } from "./data-source";
import { HubEntity } from "./entities";
import { NominatimClient } from "../collectors/nominatim.client";
import { formatHubLocations, parseRelocateArgs, type RelocateTarget } from "./hub-locations";

/**
 * Move a hub to a coordinate, a named pilot site, or a place looked up by name.
 *
 * The seed places its hub in Nairobi, which is correct for the pilot's Kenyan
 * site and useless everywhere else: a collector in Lagos fails the geofence on
 * every weigh-in. The pilot spans Kenya and Nigeria and trials several sites in
 * each, so this exists to make moving the hub routine rather than an edit to the
 * seed that quietly diverges from it.
 *
 *   npm run hub:relocate -- --list                  # the known sites
 *   npm run hub:relocate -- lagos                   # a known site
 *   npm run hub:relocate -- kisumu 500 NBO-01       # site, fence, which hub
 *   npm run hub:relocate -- "Kisii, Kenya"          # anywhere in KE/NG, via OSM
 *   npm run hub:relocate -- 9.0567 7.4969 300       # an exact coordinate
 *
 * Development only. In production a hub's coordinate is a claim about the
 * physical world that the geofence depends on, and moving it invalidates the
 * basis on which earlier weigh-ins at that hub were accepted.
 */

interface ResolvedTarget {
  lat: number;
  lng: number;
  /** How the coordinate was arrived at, for the operator to sanity-check. */
  label: string;
  /** Set when the source also told us the place name, so the hub keeps it. */
  locality: string | null;
  attribution: string | null;
}

/**
 * Turn what was asked for into a coordinate.
 *
 * A named site resolves offline from the catalogue; free text needs the geocoder.
 * The geocoder is allowed to be absent — that is a configuration choice, not a
 * fault — so the error says which knob turns it on rather than "lookup failed".
 */
async function resolve(target: Exclude<RelocateTarget, { kind: "list" }>): Promise<ResolvedTarget> {
  if (target.kind === "coordinate") {
    return {
      lat: target.lat,
      lng: target.lng,
      label: "coordinate given on the command line",
      // A bare coordinate carries no name. Leaving locality null is honest, and
      // `npm run hub:locality` fills it in from the coordinate afterwards.
      locality: null,
      attribution: null,
    };
  }

  if (target.kind === "site") {
    return {
      lat: target.site.lat,
      lng: target.site.lng,
      label: `${target.site.name} (known site, ${target.site.country})`,
      locality: null,
      attribution: null,
    };
  }

  const geocoder = new NominatimClient();
  if (!geocoder.enabled) {
    throw new Error(
      `"${target.query}" is not a known site, and looking it up needs a geocoder.\n` +
        "Set NOMINATIM_USER_AGENT (an identifying string with contact details), " +
        "or pass a coordinate, or use one of:\n\n" +
        formatHubLocations(),
    );
  }

  const found = await geocoder.forwardGeocode(target.query);
  if (!found.ok) {
    throw new Error(`could not place "${target.query}": ${found.reason} — ${found.detail}`);
  }

  return {
    lat: found.value.lat,
    lng: found.value.lng,
    label: found.value.label,
    // The search already told us what it matched, so there is no reason to spend
    // a second request reverse-geocoding the coordinate we just received.
    locality: found.value.label,
    attribution: found.value.attribution,
  };
}

async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("refusing to relocate a hub in production");
  }

  const target = parseRelocateArgs(process.argv.slice(2));

  if (target.kind === "list") {
    console.log("Known pilot sites — pass a key to hub:relocate:\n");
    console.log(formatHubLocations());
    console.log('Anywhere else in Kenya or Nigeria: hub:relocate -- "Town, Country"');
    return;
  }

  const resolved = await resolve(target);

  await AppDataSource.initialize();
  const hubs = AppDataSource.getRepository(HubEntity);

  const hub = target.hubCode
    ? await hubs.findOne({ where: { code: target.hubCode } })
    : await hubs.findOne({ where: {}, order: { createdAt: "ASC" } });

  if (!hub) {
    throw new Error(
      target.hubCode ? `no hub with code ${target.hubCode}` : "no hubs exist — run the seed first",
    );
  }

  const before = {
    lat: hub.lat,
    lng: hub.lng,
    radius: hub.geofenceRadiusM,
    locality: hub.locality,
  };

  hub.lat = resolved.lat;
  hub.lng = resolved.lng;
  if (target.radiusM !== undefined) hub.geofenceRadiusM = target.radiusM;

  // The old place name described the old coordinate. Keeping it would put a
  // label from one country on a hub now standing in another, which is worse than
  // showing no label at all.
  hub.locality = resolved.locality;
  hub.localityResolvedAt = resolved.locality ? new Date() : null;
  hub.localityAttribution = resolved.attribution;

  await hubs.save(hub);

  console.log(`${hub.code} — ${hub.name}`);
  console.log(`  matched: ${resolved.label}`);
  console.log(`  was    : ${before.lat}, ${before.lng} (fence ${before.radius} m)`);
  if (before.locality) console.log(`           ${before.locality}`);
  console.log(`  now    : ${hub.lat}, ${hub.lng} (fence ${hub.geofenceRadiusM} m)`);
  if (hub.locality) console.log(`           ${hub.locality}`);

  console.log("\nRe-enrol the capture device so it picks up the new hub coordinates.");
  if (!hub.locality) {
    console.log("No place name stored — run `npm run hub:locality` to resolve one.");
  }

  await AppDataSource.destroy();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
