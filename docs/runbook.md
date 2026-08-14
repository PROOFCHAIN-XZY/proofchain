# ProofChain Runbook

**Operational guide for running ProofChain on testnet.**

This guide covers prerequisites, infrastructure setup, service startup, common tasks, and troubleshooting.

## Prerequisites

- **Node.js 20.11 or later** — Verify with `node --version`.
- **npm 10+** — Usually bundled with Node 20+.
- **Docker** — For Postgres and Redis. If running on Linux, use the user socket (systemctl --user).
- **curl** — For testing endpoints and creating Stellar accounts.
- **A machine with 2GB+ free RAM** — Postgres, Redis, and Node services run concurrently.

### Docker Setup on Linux

Docker Desktop runs as a **user-level systemd service** on this machine, not system-wide. If docker commands fail with "permission denied", start the user daemon:

```bash
systemctl --user start docker-desktop
```

Verify Docker is running:

```bash
docker ps
```

If this still fails, ensure your user can run Docker:

```bash
usermod -aG docker $USER
newgrp docker
docker ps
```

## Infrastructure

### Start Postgres and Redis

```bash
npm run db:up
```

This starts two containers:
- **Postgres 16** on `localhost:5433` (host port 5433 → container port 5432)
- **Redis 7** on `localhost:6380` (host port 6380 → container port 6379)

**Why port 5433?** A local Postgres is already running on 5432. ProofChain uses 5433 to avoid collision.

**Why 6380?** Same reason — port 6379 is taken.

Verify both are healthy:

```bash
docker compose -f infra/docker-compose.yml ps
```

You should see both services with `healthy` status (after ~10 seconds).

To stop them:

```bash
npm run db:down
```

To completely reset (careful! destroys data):

```bash
docker compose -f infra/docker-compose.yml down -v
```

## Environment Configuration

### Copy the Example .env

```bash
cp .env.example .env
```

The `.env` file contains:

```
# Postgres
POSTGRES_USER=proofchain
POSTGRES_PASSWORD=proofchain
POSTGRES_DB=proofchain
DATABASE_URL=postgres://proofchain:proofchain@localhost:5433/proofchain

# Redis / BullMQ
REDIS_URL=redis://localhost:6380

# Backend API
PORT=3000
JWT_SECRET=change-me-in-production

# Stellar (testnet)
STELLAR_HORIZON_URL=https://horizon-testnet.stellar.org
STELLAR_NETWORK_PASSPHRASE=Test SDF Network ; September 2015
STELLAR_SECRET=             # <-- Set this after creating an account
```

**In production**, change `JWT_SECRET` to a strong random string. `STELLAR_SECRET` is the ed25519 secret key of the anchor worker's account — keep it private and rotate if compromised.

## Database Setup

### Install Dependencies and Build

```bash
npm install
npm run build
```

### Run Migrations

Migrations are TypeORM migration files that create the database schema. They run in order:

```bash
cd apps/backend
npm run migration:run
```

Expected output:

```
[TypeORM] migrations to execute: 1
[TypeORM] InitialSchema
[TypeORM] Migration InitialSchema has been executed successfully
```

If migrations fail, check that Postgres is running and the `DATABASE_URL` is correct.

### Seed the Database

The seed script creates initial entities (hub, collector, devices, users) needed for local testing:

```bash
cd apps/backend
npm run seed
```

Expected output:

```
✓ Hub created: Nairobi Pilot (UUID)
✓ Collector created: John Doe (UUID)
✓ Device 1 enrolled: d1 (UUID) — public key ...
✓ Device 2 enrolled: d2 (UUID) — public key ...
✓ Device 3 enrolled: d3 (UUID) — public key ...
✓ Operator user created: operator@proofchain.local
```

The seed stores the device private keys in `apps/backend/var/seed-devices.json` for use by the demo script.

## Stellar Setup

### Create and Fund a Testnet Account

The anchor worker needs a Stellar testnet account with a small balance to pay for transaction fees (~0.00001 XLM per anchor).

```bash
npm run stellar:account
```

This runs `services/anchor-worker/scripts/create-testnet-account.mjs`, which:
1. Generates a random ed25519 keypair
2. Funds it via Friendbot (free testnet faucet)
3. Prints the keys

Output:

```
Public : GBUQWP3BOUZX34LOCALWHATSAMPLE...
Secret : SBXXXXXXXXXXXXXXXXXXXXXXXXXXXX...

Funded on testnet via Friendbot.
STELLAR_SECRET=SBXXXXXXXXXXXXXXXXXXXXXXXXXXXX...
```

**Copy the `STELLAR_SECRET` line into `.env`:**

```bash
# Edit .env and paste:
STELLAR_SECRET=SBXXXXXXXXXXXXXXXXXXXXXXXXXXXX...
```

**Important:** Never reuse this key on the public network. Testnet lumens have no value, but the key pattern is the same.

### Verify Funding

```bash
curl "https://horizon-testnet.stellar.org/accounts/GBUQWP3BOUZX34LOCALWHATSAMPLE..." | jq '.balances'
```

You should see a balance of 10,000 XLM (Friendbot's default).

## Service Startup

### Backend API

**Terminal 1:**

```bash
cd apps/backend
npm run start:dev
```

Watches for changes and rebuilds. Output:

```
[Nest] 1234  - 08/08/2024, 14:30:00   LOG [bootstrap] ProofChain API listening on :3000 (development) — docs at /docs
```

Access Swagger docs at `http://localhost:3000/docs` (dev mode only).

Health check:

```bash
curl http://localhost:3000/health | jq .
```

### Anchor Worker

**Terminal 2:**

```bash
cd services/anchor-worker
npm run dev
```

The worker polls the backend every 15 seconds for sealed-but-unanchored batches. Output:

```
anchor-worker up. backend=http://localhost:3000 poll=15000ms
```

Once a batch is sealed (see next section), you'll see:

```
[anchored] batch=... weight=125.3kg events=9 tx=3fb0f496f209507098e6439c646a60d6a576de856a28afbb4f44598b77dc512f ledger=4033690
```

### Dashboard (Optional)

**Terminal 3:**

```bash
cd apps/dashboard
npm run dev
```

Access at `http://localhost:3001`. Shows batch management, event lists, and custody transfers.

### Capture PWA (Optional)

**Terminal 4:**

```bash
cd apps/capture
npm run dev
```

Access at `http://localhost:3002`. Mimics the field weigh-in flow: sign events, queue, sync. For testing, use the demo script instead.

### Mobile App (Optional)

```bash
cd apps/mobile
npm start
```

Starts the Expo CLI. Press `i` for iOS or `a` for Android (requires simulator/device). Same signing contract as capture PWA.

## Common Tasks

### Create a Test Batch and Anchor It

1. **Open a batch:**
   ```bash
   curl -X POST http://localhost:3000/batches \
     -H "Content-Type: application/json" \
     -H "Authorization: Bearer <JWT_TOKEN>" \
     -d '{"hubId": "<hub_uuid>", "material": "PET"}'
   ```
   
   (You need a JWT token from logging in first; see the demo script for how it's obtained.)

2. **Run the demo** (easier):
   ```bash
   node scripts/demo-e2e.mjs
   ```
   
   This does all the work: creates events, batches, seals, anchors, and verifies.

### List Batches

```bash
curl http://localhost:3000/batches | jq '.'
```

### Download an Audit Report

```bash
curl http://localhost:3000/batches/<batch_id>/report | jq '.'
```

### Check Pending Anchors

```bash
curl http://localhost:3000/batches/pending-anchor | jq '.'
```

The anchor worker periodically polls this endpoint. Batches in backoff after a failed attempt are deliberately absent — a batch missing from this list is not necessarily anchored.

### Check Whether Anchoring Is Healthy

This is the endpoint to reach for first when a batch has not anchored. It requires an operator token.

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/batches/anchor-health | jq '{awaitingAnchor, stuck, unanchoredWeightKg}'
```

- `awaitingAnchor` — sealed batches with no anchor. A small number that keeps changing is normal.
- `stuck` — batches that have failed six or more times. **This is the number to alert on.** Anything above zero needs a person.
- `unanchoredWeightKg` — the same fact in business units: weight that cannot be sold until a root reaches the ledger.

For the detail on a specific batch:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/batches/anchor-health | jq '.batches[] | select(.stuck)'
```

`lastDetail` carries the error verbatim from Horizon or the Stellar SDK. The common causes:

| `lastDetail` contains | Cause | Fix |
|---|---|---|
| `op_underfunded`, `tx_insufficient_balance` | The anchor account has run out of XLM | Re-fund via Friendbot (testnet) — see [Stellar Setup](#stellar-setup) |
| `tx_insufficient_fee` | Network base fee has risen above `BASE_FEE` | Raise the fee in `services/anchor-worker/src/anchor.ts` and redeploy the worker |
| `tx_bad_seq` | Two workers sharing one Stellar key | Run exactly one anchor worker per key |
| `504`, `timed out`, `ECONNREFUSED` | Horizon unreachable | Usually transient; backoff will retry. Check `STELLAR_HORIZON_URL` |
| `unauthorised (401)` | `ANCHOR_WORKER_TOKEN` mismatch | Make the worker's and the backend's values identical |

### Recover a Stuck Batch

Nothing needs to be reset by hand. Once the underlying cause is fixed, the batch is retried on its next scheduled attempt — at most an hour away, since backoff is capped.

To confirm it recovered:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/batches/anchor-health | jq '.stuck'
```

The batch leaves the list entirely once anchored. Its failure history is kept and remains visible on the batch page in the dashboard, which is intentional: "anchored, eventually, after nine failures" is a different operational fact from "anchored first time" and it should not be erased by the recovery.

### View Event Details

```bash
curl http://localhost:3000/batches/<batch_id>/events | jq '.'
```

## Troubleshooting

### "Can't connect to Postgres"

**Symptom:** `error: connect ECONNREFUSED 127.0.0.1:5433`

**Solution:**
1. Check Docker is running: `docker ps`
2. If Docker failed to start, see [Docker Setup on Linux](#docker-setup-on-linux)
3. Restart services: `npm run db:down && npm run db:up`
4. Verify connection: `docker compose -f infra/docker-compose.yml exec postgres pg_isready`

### "Docker permission denied"

**Symptom:** `permission denied while trying to connect to Docker daemon`

**Solution:** On this system, Docker runs as a user service:

```bash
systemctl --user start docker-desktop
```

Then retry your docker command.

### "Database migrations failed"

**Symptom:** `TypeORM migration error` or `table already exists`

**Solution:**
1. Check Postgres is healthy: `docker compose -f infra/docker-compose.yml ps`
2. If fresh start, migrations should work. If the database was partially seeded, you may need to reset:
   ```bash
   docker compose -f infra/docker-compose.yml down -v
   npm run db:up
   # Then re-run migrations and seed
   ```

### "Anchor worker can't reach backend"

**Symptom:** `backend returned 500` or `ECONNREFUSED`

**Solution:**
1. Check backend is running: `curl http://localhost:3000/health`
2. If backend is down, restart it: `cd apps/backend && npm run start:dev`
3. Anchor worker will retry on the next poll (default 15s)

### "Stellar account not funded"

**Symptom:** `STELLAR_SECRET is not set` or `insufficient native asset balance`

**Solution:**
1. Create an account: `npm run stellar:account`
2. Copy the secret to `.env`
3. Verify funding: `curl "https://horizon-testnet.stellar.org/accounts/<public_key>" | jq '.balances'`
4. If the account shows 0 XLM, re-run Friendbot manually:
   ```bash
   PUBKEY=$(node -e "console.log(require('@stellar/stellar-sdk').Keypair.fromSecret('YOUR_SECRET').publicKey())")
   curl "https://friendbot.stellar.org?addr=$PUBKEY"
   ```

### "Transaction submitted but anchor worker doesn't record it"

**Symptom:** Batch seals and anchors appear in Horizon, but the backend still shows no anchor record.

**Solution:**
1. Check the anchor worker logs — if verification fails, it doesn't record (safety feature):
   ```
   [unverified] batch=... tx=... memo=false data=false — not recording
   ```
2. Verify the Stellar tx manually: `curl https://horizon-testnet.stellar.org/transactions/<tx_hash> | jq '.memo'`
3. Check the backend's anchor endpoint is reachable and has the correct `x-anchor-worker-token` header.
4. The worker now reports this case as an `unverified` attempt with the transaction hash. Find it with:
   ```bash
   curl -H "Authorization: Bearer $TOKEN" \
     http://localhost:3000/batches/anchor-health | jq '.batches[] | select(.lastOutcome == "unverified")'
   ```
   An `unverified` attempt is more serious than a plain failure: a transaction was submitted and may have cost a real fee, and it may still settle. Check the hash on Horizon before assuming the anchor did not happen — anchoring the same root twice is wasteful but harmless, whereas recording an anchor that was never confirmed is not.

### "TypeScript build errors"

**Symptom:** `tsc --noEmit` fails with type errors

**Solution:**
```bash
npm run typecheck
# Identify and fix the error, or use:
npm run build --workspaces
# to build all and see which workspace has the issue
```

### "Port already in use"

**Symptom:** `listen EADDRINUSE :::3000` or `:3001` etc.

**Solution:**
1. Find what's using the port:
   ```bash
   lsof -i :3000
   ```
2. Kill it (if it's a stray Node process):
   ```bash
   kill -9 <PID>
   ```
3. Or use a different port:
   ```bash
   PORT=3001 npm run start
   ```

### "Out of memory"

**Symptom:** Node process terminates or "JavaScript heap out of memory"

**Solution:**
1. Increase Node's heap (useful for type-checking large projects):
   ```bash
   NODE_OPTIONS="--max-old-space-size=4096" npm run build
   ```
2. Close other memory-heavy applications (browser tabs, IDEs, etc.)
3. Add swap space if running on a VM with limited RAM.

## Maintenance

### Backing Up the Database

```bash
docker compose -f infra/docker-compose.yml exec postgres pg_dump -U proofchain proofchain > backup.sql
```

### Restoring from Backup

```bash
docker compose -f infra/docker-compose.yml exec -T postgres psql -U proofchain proofchain < backup.sql
```

### Clearing All Data

```bash
docker compose -f infra/docker-compose.yml down -v
npm run db:up
cd apps/backend && npm run migration:run && npm run seed
```

### Restarting Everything

```bash
npm run db:down
npm run db:up
# Then restart services in terminals
```

## Production Deployment

**This is a testnet pilot. DO NOT deploy to production without:**

1. Security audit of the signing contract and integrity checks
2. Stellar public network account setup (not testnet)
3. Verra accreditation as a carbon credit issuer
4. HTTPS/TLS for all endpoints
5. Rate limiting and API key management
6. Database backups and disaster recovery plan
7. Monitoring and alerting (logs, metrics, uptime)

For now, testnet is the safe zone for development and testing.

## Testing the capture PWA on a real phone

Geolocation, the camera and service workers are all gated behind a **secure
context**: HTTPS, or `localhost`. A phone opening the app over the office wifi at
`http://192.168.x.x:3002` is an insecure origin, and the browser will report GPS
as "permission denied" no matter what the phone's settings say. The app detects
this and shows a banner naming HTTPS as the cause, rather than letting the
collector hunt through phone settings.

Serve it over HTTPS instead:

```bash
npm run dev:capture:https      # or, in apps/capture: npm run preview:https
```

Vite prints a Network URL such as `https://192.168.46.157:3002/`. The
certificate is self-signed, so the phone shows a warning once — accept it, and
the origin becomes a real secure context with working GPS and offline support.

Two things to remember:

- Point the app's **Backend URL** at the machine's LAN address
  (`http://192.168.x.x:3000`), not `localhost:3000` — on the phone, `localhost`
  is the phone.
- The backend accepts loopback and private-network origins automatically in
  development, so a changing DHCP address needs no config edit. In production the
  explicit `CORS_ORIGINS` allowlist is the only thing honoured.

An alternative for a USB-connected Android device is `adb reverse tcp:3002
tcp:3002` (and `tcp:3000` for the API), which lets the phone reach the app at
`http://localhost:3002` — already a secure context, no certificate needed.

## Setting the hub location

Weigh-ins are geofenced against a hub, so a hub on the wrong continent
quarantines everything a developer captures. The seed defaults to Nairobi
(the pilot site); there are two ways to point it somewhere else.

**Before seeding** — environment variables:

```bash
HUB_LAT=9.06035 HUB_LNG=7.46783 HUB_GEOFENCE_M=500 npm run seed
```

**After seeding** — relocate the existing hub:

```bash
npm run hub:relocate -- <lat> <lng> [radiusM] [hubCode]
```

Re-enrol the capture device afterwards: it stores the hub's coordinates and
fence at enrolment so it can refuse an unusable fix before signing, and a stale
copy would judge against the old location.

Nothing else hardcodes a coordinate. The demo script and the browser suites read
the hub from `GET /hubs` at startup, so they follow wherever it is. The fixed
coordinates in `*/test/*` are unit-test fixtures and are meant to stay fixed.

A note on accuracy: desktop browsers have no GPS chip and fall back to IP-based
location, typically accurate to hundreds of kilometres. The capture app refuses
any fix whose error radius exceeds the hub's fence, since such a fix cannot place
the collector inside it. Use a phone for a realistic fix.

### The demo follows the operator

`npm run demo` resolves your approximate position from your public IP and, if the
hub is further away than its geofence, moves the hub to you before capturing.
Without that, running the demo anywhere other than the pilot site quarantines
every weigh-in and reports only "0/12 passed integrity v1".

Be clear about what this costs: once the hub sits where you are, the server's
`geofence_ok` check passes by construction and proves nothing on that run. The
demo prints a warning saying so. The tamper detection in step 3 is unaffected —
it defeats a forged signature and an inflated weight, neither of which depends on
location.

| Variable | Effect |
|---|---|
| *(none)* | Resolve position from public IP, move the hub if needed |
| `DEMO_LOCATION=hub` | Never move the hub — use it as seeded |
| `DEMO_LAT`, `DEMO_LNG` | Use these coordinates instead of an IP lookup |
| `DEMO_GEOIP_URL` | Point the lookup at a different service |

The lookup sends your IP to `ip-api.com`. Set `DEMO_LOCATION=hub` to avoid that
call entirely. If the lookup fails for any reason the demo says so and carries on
with the seeded hub, so an offline machine still runs.
