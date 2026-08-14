import "reflect-metadata";
import { config as loadDotenv } from "dotenv";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  generateDeviceKeypair,
  privateKeyToPem,
  publicKeyToBase64,
} from "@proofchain/shared";
import { AppDataSource } from "./data-source";
import { CollectorEntity, DeviceEntity, HubEntity, UserEntity } from "./entities";
import { AuthService } from "../auth/auth.module";

loadDotenv();

type DeviceSecret = Record<string, string>;

/**
 * Device private keys written by a previous seed run, keyed by device id.
 *
 * A missing file is the normal first-run case, and a corrupt one is treated the
 * same way: "we hold no keys". Neither is fatal, because the device loop below
 * already knows how to handle an enrolled device whose key it cannot find — it
 * enrols a replacement. Throwing here would turn a scratch file into a hard
 * blocker on a development seed.
 */
function readExistingSecrets(path: string): Map<string, DeviceSecret> {
  const known = new Map<string, DeviceSecret>();

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`could not read ${path}; treating it as empty:`, error);
    }
    return known;
  }

  try {
    const parsed = JSON.parse(raw) as { devices?: DeviceSecret[] };
    for (const entry of parsed.devices ?? []) {
      // Both halves are required: an entry without a private key is no more
      // useful than a missing entry, and would suppress the replacement path.
      if (entry?.deviceId && entry.privateKeyPem) {
        known.set(entry.deviceId, entry);
      }
    }
  } catch (error) {
    console.warn(`${path} is not valid JSON; treating it as empty:`, error);
  }

  return known;
}

/**
 * Development seed: one hub, two collectors, one enrolled device each, and
 * operator/auditor logins. The device PRIVATE keys are written to
 * `var/seed-devices.json` so the capture app and the demo script can sign as a
 * real enrolled device. Development only — never run against production.
 */
async function seed(): Promise<void> {
  if (process.env.NODE_ENV === "production") {
    throw new Error("refusing to seed a production database");
  }

  // `var/` is gitignored, so on a fresh clone it does not exist. Created here,
  // before any database write, rather than at the point of use at the end: a
  // seed that half-populates the database and *then* dies on ENOENT leaves
  // devices enrolled whose private keys were never written down, and those keys
  // cannot be recovered by re-running (see the device loop below).
  const outPath = resolve(__dirname, "../../var/seed-devices.json");
  mkdirSync(dirname(outPath), { recursive: true });

  // Keys already on disk are carried forward, so re-running the seed does not
  // orphan the devices an earlier run enrolled.
  const knownSecrets = readExistingSecrets(outPath);

  await AppDataSource.initialize();

  const hubs = AppDataSource.getRepository(HubEntity);
  const collectors = AppDataSource.getRepository(CollectorEntity);
  const devices = AppDataSource.getRepository(DeviceEntity);
  const users = AppDataSource.getRepository(UserEntity);

  // The pilot hub is Nairobi, but anyone developing elsewhere needs a hub they
  // can physically stand in — otherwise every captured weigh-in fails the
  // geofence and the app looks broken. Override without editing this file:
  //   HUB_LAT=9.06035 HUB_LNG=7.46783 HUB_GEOFENCE_M=500 npm run seed
  // An existing hub is left alone; use `npm run hub:relocate` to move one.
  const hubLat = Number(process.env.HUB_LAT ?? -1.286389);
  const hubLng = Number(process.env.HUB_LNG ?? 36.817223);
  const hubFence = Number(process.env.HUB_GEOFENCE_M ?? 300);

  if (!Number.isFinite(hubLat) || hubLat < -90 || hubLat > 90) {
    throw new Error(`HUB_LAT is not a valid latitude: ${process.env.HUB_LAT}`);
  }
  if (!Number.isFinite(hubLng) || hubLng < -180 || hubLng > 180) {
    throw new Error(`HUB_LNG is not a valid longitude: ${process.env.HUB_LNG}`);
  }
  if (!Number.isFinite(hubFence) || hubFence <= 0) {
    throw new Error(`HUB_GEOFENCE_M must be a positive number: ${process.env.HUB_GEOFENCE_M}`);
  }

  let hub = await hubs.findOne({ where: { code: "NBO-01" } });
  if (!hub) {
    hub = await hubs.save(
      hubs.create({
        code: "NBO-01",
        name: "Nairobi Pilot Hub",
        lat: hubLat,
        lng: hubLng,
        geofenceRadiusM: Math.round(hubFence),
        minWeightKg: 0.5,
        maxWeightKg: 200,
      }),
    );
  }

  const seedCollectors = [
    { name: "Amina Wanjiru", phone: "+254700000001" },
    { name: "Joseph Otieno", phone: "+254700000002" },
  ];

  const deviceSecrets: DeviceSecret[] = [];

  for (const spec of seedCollectors) {
    let collector = await collectors.findOne({ where: { phone: spec.phone } });
    if (!collector) {
      collector = await collectors.save(
        collectors.create({
          name: spec.name,
          phone: spec.phone,
          cooperativeId: "coop-nairobi-1",
          kycLevel: "basic",
          homeLat: hub.lat,
          homeLng: hub.lng,
          active: true,
        }),
      );
    }

    const existingDevice = await devices.findOne({ where: { collectorId: collector.id } });
    if (existingDevice) {
      const heldKey = knownSecrets.get(existingDevice.id);
      if (heldKey) {
        // Normal re-run: the device is enrolled and we still hold its key.
        deviceSecrets.push({ ...heldKey, hubId: hub.id });
        console.log(`device already enrolled for ${collector.name}; key retained`);
        continue;
      }

      // The device row exists but its private key is nowhere on disk — it was
      // generated by a run that failed before writing the file. The key is
      // unrecoverable (only the public half is stored), so the collector is
      // given a NEW device rather than being left permanently unable to sign.
      // The orphaned row stays: it is the enrolment history, and revoking it
      // here would rewrite an audit record to paper over a local mishap.
      console.warn(
        `device ${existingDevice.id} for ${collector.name} has no private key on disk; ` +
          `enrolling a replacement device`,
      );
    }

    const keypair = generateDeviceKeypair();
    const device = await devices.save(
      devices.create({
        collectorId: collector.id,
        label: `${spec.name.split(" ")[0]}'s phone`,
        publicKeyBase64: publicKeyToBase64(keypair.publicKey),
        revokedAt: null,
      }),
    );

    deviceSecrets.push({
      collectorId: collector.id,
      collectorName: collector.name,
      deviceId: device.id,
      hubId: hub.id,
      publicKeyBase64: device.publicKeyBase64,
      privateKeyPem: privateKeyToPem(keypair.privateKey),
    });
  }

  const seedUsers: Array<{ email: string; password: string; role: UserEntity["role"] }> = [
    { email: "operator@proofchain.local", password: "operator-dev-password", role: "operator" },
    { email: "auditor@proofchain.local", password: "auditor-dev-password", role: "auditor" },
    { email: "admin@proofchain.local", password: "admin-dev-password", role: "admin" },
  ];

  for (const u of seedUsers) {
    const existing = await users.findOne({ where: { email: u.email } });
    if (existing) continue;
    await users.save(
      users.create({
        email: u.email,
        passwordHash: await AuthService.hashPassword(u.password),
        role: u.role,
        active: true,
      }),
    );
  }

  if (deviceSecrets.length > 0) {
    writeFileSync(outPath, JSON.stringify({ hubId: hub.id, devices: deviceSecrets }, null, 2));
    console.log(`wrote device keys -> ${outPath}`);
  }

  console.log(`hub: ${hub.code} (${hub.id})`);
  console.log("logins: operator@proofchain.local / operator-dev-password (and auditor, admin)");

  await AppDataSource.destroy();
}

seed().catch((error) => {
  console.error("seed failed:", error);
  process.exit(1);
});
