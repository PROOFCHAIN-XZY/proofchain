import "reflect-metadata";
import { config as loadDotenv } from "dotenv";
loadDotenv();
import { AppDataSource } from "./data-source";
import { HubEntity } from "./entities";
import { NominatimClient } from "../collectors/nominatim.client";

/**
 * Fill in the place name for hubs that have none.
 *
 *   npm run hub:locality -w @proofchain/backend            # only missing labels
 *   npm run hub:locality -w @proofchain/backend -- --force  # re-resolve all
 *
 * Needed because the label column arrived after hubs already existed, and
 * because hub creation treats geocoding as best-effort — a hub enrolled while
 * OSM was unreachable has a null label and no other way to acquire one.
 *
 * Deliberately serial with a delay between calls: OSM's public instance allows
 * one request per second, and this is the only place in the codebase that could
 * ever issue more than one lookup in a row.
 */

/** One per second is the published limit; 1.1 s leaves headroom for clock jitter. */
const REQUEST_INTERVAL_MS = 1_100;

/**
 * Transport failures get one more chance before the hub is written off.
 *
 * Observed on a phone-tethered link: the geocoder's host is dual-stack, IPv6 is
 * black-holed, and Node prefers the AAAA record — so `fetch` fails in under a
 * second while curl on the same machine succeeds. That flaps, so a single
 * attempt turns a working setup into "no label" and a manual re-run. Only
 * `unavailable` is retried: a coordinate the service has no name for will
 * produce the same answer however many times it is asked.
 *
 * `NODE_OPTIONS=--dns-result-order=ipv4first` is the real fix on such a link;
 * see the runbook. This just keeps the script from needing it.
 */
const TRANSPORT_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1_500;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const force = process.argv.slice(2).includes("--force");

  const geocoder = new NominatimClient();
  if (!geocoder.enabled) {
    throw new Error(
      "reverse geocoding is disabled: set NOMINATIM_USER_AGENT to an identifying string " +
        'with contact details, e.g. "proofchain/0.1 (ops@example.org)" — OSM\'s usage ' +
        "policy requires it and blocks generic agents.",
    );
  }

  await AppDataSource.initialize();
  const hubs = AppDataSource.getRepository(HubEntity);

  const all = await hubs.find({ order: { code: "ASC" } });
  const pending = force ? all : all.filter((hub) => hub.locality === null);

  if (pending.length === 0) {
    console.log(
      all.length === 0 ? "no hubs exist — run the seed first" : "every hub already has a label",
    );
    await AppDataSource.destroy();
    return;
  }

  console.log(`resolving ${pending.length} of ${all.length} hub(s)\n`);

  let resolved = 0;
  for (const [index, hub] of pending.entries()) {
    if (index > 0) await sleep(REQUEST_INTERVAL_MS);

    let result = await geocoder.reverseGeocode(hub.lat, hub.lng);
    for (let attempt = 2; attempt <= TRANSPORT_ATTEMPTS && !result.ok; attempt += 1) {
      if (result.reason !== "unavailable") break;
      console.log(`${hub.code}  —  ${result.reason}, retrying (${attempt}/${TRANSPORT_ATTEMPTS})`);
      await sleep(RETRY_DELAY_MS);
      result = await geocoder.reverseGeocode(hub.lat, hub.lng);
    }

    if (!result.ok) {
      // Reported, not thrown: one unresolvable hub should not abandon the rest,
      // and a missing label is a benign state the report already handles.
      console.log(`${hub.code}  —  no label (${result.reason}: ${result.detail})`);
      continue;
    }

    hub.locality = result.value.label;
    hub.localityResolvedAt = new Date();
    hub.localityAttribution = result.value.attribution;
    await hubs.save(hub);
    resolved += 1;

    console.log(`${hub.code}  —  ${result.value.label}`);
  }

  console.log(`\n${resolved} of ${pending.length} hub(s) labelled`);
  await AppDataSource.destroy();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
