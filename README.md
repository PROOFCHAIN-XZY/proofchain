# ProofChain

**Verified waste-to-credit platform on Stellar (testnet phase)**

Waste collectors record weigh-ins of recycled plastic on phones. Each weigh-in is cryptographically signed on-device with an ed25519 key (the private key never leaves the phone). The server runs integrity checks to detect spoofing, groups clean events into batches, seals a batch by computing a Merkle tree, and anchors the root onto the Stellar testnet ledger. The result is an audit report containing Merkle proofs and the Stellar transaction, which any credit buyer can verify independently.

## Why This Matters

A plastic credit is worth $140–800 per tonne, creating direct financial incentive to spoof weigh-ins. ProofChain's guarantee is:

1. **Authenticity** — Every weigh-in is signed by an enrolled device. Tampering with the payload invalidates the signature.
2. **Integrity** — Events pass server-side checks (geofence, weight range, duplicate detection, clock plausibility, device enrollment).
3. **Immutability** — The Merkle root is anchored on Stellar, proving the batch membership and order cannot be altered after sealing.
4. **Verifiability** — Any third party can independently recompute the Merkle root from the event list, check one event's proof, and compare the root to the Stellar transaction on Horizon.

**Maturity note:** This is a testnet pilot build. The platform is not yet a certified credit issuer. Verra accreditation, photo verification, and per-collector behavioral baselining are not in scope for this release.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│ Offline-first Capture (capture PWA + mobile Expo app)           │
│  • Ed25519 signing on-device                                     │
│  • GPS + photo hash + weight from scale                           │
│  • IndexedDB queue for offline operation                          │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         │ POST /events (signed payload + signature)
                         │
┌────────────────────────▼────────────────────────────────────────┐
│ Backend (NestJS + Postgres + Redis)                             │
│  • Integrity v1 checks (7 checks: signature, geofence, etc.)    │
│  • Batch management                                              │
│  • Merkle tree sealing                                           │
│  • Chain of custody tracking                                     │
└────────────────────────┬────────────────────────────────────────┘
                         │
          ┌──────────────┴──────────────┐
          │                             │
          │ (sealed batch)              │
          │                             │
    ┌─────▼──────────┐         ┌───────▼──────────┐
    │ Anchor Worker  │         │ Reports Service  │
    │  • Builds tx   │         │  • Merkle proofs │
    │  • Posts to    │         │  • Audit report  │
    │    Stellar     │         │  • CSV export    │
    │  • Verifies    │         │                  │
    │    ledger      │         │                  │
    └─────┬──────────┘         └──────────────────┘
          │
          │ manageData + memo.hash(root)
          │
    ┌─────▼──────────────────────────────┐
    │ Stellar Testnet (classic layer)    │
    │ https://horizon-testnet.stellar.org│
    └────────────────────────────────────┘
          │
          │ GET /transactions/:hash
          │
    ┌─────▼──────────────────────────────┐
    │ Auditor / Credit Buyer              │
    │  • Download audit report            │
    │  • Recompute Merkle root            │
    │  • Verify proof on Horizon          │
    │  • Accept tonne as proven           │
    └────────────────────────────────────┘
```

### Data Flow: Weigh-In to Audit Report

1. **Capture** — Collector uses phone/PWA to photograph a weigh-in. Device signs the payload (schema, IDs, weight, location, photo hash, timestamp, nonce) with its ed25519 private key.
2. **Ingest** — Server receives payload + signature. Public signature verification ensures authenticity. Database check on payload hash prevents replay (replay = identical nonce).
3. **Integrity** — Server runs 7 checks: device enrolled, signature valid, geofence (within hub radius), weight in range, not a duplicate, clock plausible, photo hash is valid sha256. Any *fail* quarantines the event; it never enters a batch.
4. **Batch** — Operator opens a batch for a hub + material. Cleans events are added to the batch. Operator seals the batch, which computes a Merkle tree from the event hashes and freezes membership.
5. **Anchor** — Background worker reads the sealed batch, submits a Stellar transaction writing the Merkle root to the ledger (via `manageData` and `memo.hash`), and verifies it back off the ledger before recording the transaction ID.
6. **Report** — Auditor or buyer downloads the audit report for a batch. It contains all events, their Merkle proofs, the sealed root, and the Stellar transaction. The buyer can independently verify the root and proofs without trusting ProofChain.

## Repo Layout

```
proofchain/
├── README.md                      # This file
├── docs/
│   ├── runbook.md                 # Operational guide
│   ├── verification.md            # Auditor's verification guide
│   └── architecture.md            # Data model, integrity checks, design decisions
├── apps/
│   ├── backend/                   # NestJS API + Postgres + Batch sealing
│   ├── dashboard/                 # Next.js operator UI
│   ├── capture/                   # Vite PWA for field weigh-ins
│   └── mobile/                    # Expo/React Native collector app
├── packages/
│   └── shared/                    # Trust kernel: signing, Merkle tree, types (46 tests)
├── services/
│   └── anchor-worker/             # Polls batches, anchors to Stellar, verifies
├── contracts/
│   └── batch-registry/            # Soroban contract (deferred to post-pilot)
├── infra/
│   └── docker-compose.yml         # Postgres (port 5433) + Redis (port 6380)
└── scripts/
    └── demo-e2e.mjs               # End-to-end smoke test
```

## Quickstart

### Prerequisites
- Node.js 20.11+
- Docker (for Postgres + Redis)
- A funded Stellar testnet account (generated via Friendbot)

### Setup

1. **Clone and install dependencies:**
   ```bash
   npm install
   ```

2. **Start Postgres and Redis:**
   ```bash
   npm run db:up
   ```
   Postgres listens on localhost:5433 (not 5432). Redis on localhost:6380.

3. **Set up environment variables:**
   ```bash
   cp .env.example .env
   ```
   The `.env` file contains placeholders for:
   - `DATABASE_URL` — Postgres connection (already set to localhost:5433)
   - `REDIS_URL` — Redis connection (already set to localhost:6380)
   - `JWT_SECRET` — Backend session secret (change in production)
   - `STELLAR_SECRET` — Anchor worker's signing key (set after creating account)

4. **Create a funded Stellar testnet account:**
   ```bash
   npm run stellar:account
   ```
   This generates a random keypair, funds it via Friendbot, and prints the secret. Copy the secret into `.env` as `STELLAR_SECRET`.

5. **Run database migrations and seed:**
   ```bash
   cd apps/backend
   npm run migration:run
   npm run seed
   ```
   The seed creates:
   - One hub (Nairobi Pilot Hub, geofence 300 m)
   - Two collectors (Amina Wanjiru, Joseph Otieno)
   - One enrolled ed25519 device per collector, with the private keys written to
     `apps/backend/var/seed-devices.json` so the capture app and the demo can
     sign as a real enrolled device
   - Three users: `operator@proofchain.local` / `operator-dev-password`, plus
     `auditor@` and `admin@` with matching `-dev-password` suffixes

6. **Build and start services:**
   ```bash
   # Build all workspaces
   npm run build

   # Terminal 1: Backend API (port 3000)
   cd apps/backend && npm run start:dev

   # Terminal 2: Anchor worker (polls every 15s by default)
   cd services/anchor-worker && npm run dev

   # Terminal 3 (optional): Dashboard (port 3001)
   cd apps/dashboard && npm run dev

   # Terminal 4 (optional): Capture PWA (port 3002)
   cd apps/capture && npm run dev
   ```

### Run the End-to-End Demo

The demo smoke-tests the entire pipeline: creates 12 signed weigh-ins, opens a batch, seals it, anchors to Stellar, verifies the ledger, and downloads the audit report.

**Requirements:** Backend running on :3000, database seeded, anchor worker built, Stellar account funded.

```bash
node scripts/demo-e2e.mjs
```

**Expected output:**
```
[1/8] Authenticating as the hub operator
[2/8] Capturing signed weigh-ins from enrolled devices
  9/12 weigh-ins passed integrity v1
[3/8] Proving a tampered weigh-in is rejected
  inflated weigh-in quarantined=true; failed checks: weight_in_range
[4/8] Opening a batch and adding the clean events
[5/8] Sealing the batch (membership and Merkle root freeze here)
[6/8] Recording chain of custody with reconciliation
[7/8] Anchoring the root on Stellar testnet
  [anchored] batch=... tx=3fb0f496f209507098e6439c646a60d6a576de856a28afbb4f44598b77dc512f ...
[8/8] Fetching the audit artifact and verifying it independently
  End-to-end verified. batch=...
  Audit report : http://localhost:3000/batches/.../report
  Event CSV    : http://localhost:3000/batches/.../report/events.csv
```

## What's Included in This Release

- **Weigh-in signing** — Devices sign payloads on-device; server verifies.
- **Integrity v1** — 7 checks covering signature, enrollment, geofence, weight, duplicates, clock, photo hash.
- **Batch sealing** — Merkle tree computation, membership freeze.
- **Stellar anchoring** — Classic layer (`manageData` + `memo.hash`), testnet only.
- **Independent verification** — Merkle proofs, Horizon lookup, audit report.
- **Ledger read-back** — the verify endpoint and the audit report re-read the
  anchor off Horizon rather than reporting our own stored record of it.
- **Operator dashboard** — View batches, events, custody transfers.
- **Offline-first capture** — PWA and Expo app with IndexedDB queue.

## What's NOT in Scope Yet

- **Photo verification** — Photo bytes are hashed but not analysed for material/tampering.
- **Behavioral baselining** — Per-collector anomaly detection deferred to v2.
- **Soroban credit contract** — Post-pilot; classic layer proves immutability, Soroban reserves stateful credit logic.
- **Public network deployment** — Testnet only.
- **Verra accreditation** — This is a technical proof, not a credit issuer.

## Documentation

- **[Runbook](docs/runbook.md)** — How to run each service, troubleshoot Docker on this machine, fund a Stellar key.
- **[Verification](docs/verification.md)** — How an auditor independently verifies a batch without trusting ProofChain.
- **[Architecture](docs/architecture.md)** — Data model, the 8 database tables, integrity v1 checks, design rationale.

## API Endpoints (Swagger at /docs in dev mode)

### Public (no auth required)
- `GET /batches/:id` — Fetch batch metadata
- `GET /batches/:id/report` — Audit artifact (JSON)
- `GET /batches/:id/report/events.csv` — Event CSV export
- `GET /batches/:id/verify/:eventId` — Merkle proof for one event
- `GET /batches/:id/ledger` — re-read this batch's anchor off Horizon
- `POST /events` — Ingest a signed weigh-in

### Operator (JWT required)
- `POST /batches` — Open a batch
- `POST /batches/:id/events` — Add events to a batch
- `POST /batches/:id/seal` — Seal and compute Merkle root
- `POST /batches/:id/custody` — Record chain of custody

### Health
- `GET /health` — Liveness check

## Known Limitations

- **Ledger read-back is best-effort** — `rootMatchesLedger` is `null` when
  Horizon cannot be reached. That is a fact about the network, not about the
  batch, and an auditor should run the Horizon queries in
  [verification.md](docs/verification.md) rather than rely on our answer.
- **Confirmations are cached in memory** — a confirmed anchor is cached for the
  process lifetime (a ledger entry never changes), so the cache is lost on
  restart. Persisting it is worth doing once there is more than one API replica.
- **Timestamp-only integrity** — Clock skew tolerance is ±15 seconds. Offline sync is allowed (warn outcome) but flagged.
- **No rollback** — Once a batch is sealed, it cannot be modified. Events cannot be removed from a sealed batch.
- **Single-thread anchoring** — The worker processes one batch at a time. High-volume use requires async job queue (BullMQ integration planned).
- **No rate limiting per collector** — Integrity v1 has no behavioral throttling; v2 will add per-collector quotas.
- **Testnet only** — Public network deployment requires security audit and Verra vetting.

## Development

### Running Tests

```bash
npm run test         # All workspaces
npm run typecheck    # TypeScript type-check
npm run lint         # ESLint (if configured per-workspace)
```

### Adding a New Check

Integrity checks live in `apps/backend/src/events/integrity.ts`. To add a check:

1. Add a function `checkYourCheck(payload, ctx): IntegrityFinding`.
2. Add it to the `findings` array in `evaluateIntegrity()`.
3. Document what it defends against.
4. Add tests in the backend's test suite.

### Modifying the Data Model

Database schema is managed via TypeORM migrations:

```bash
cd apps/backend

# After changing an entity file:
npm run migration:generate -- -n YourMigrationName

# Then review and apply:
npm run migration:run
```

Never use `synchronize: true` in production.

## Verified Facts

The full pipeline has been run live on Stellar testnet. A real anchor was produced and independently confirmed:

- **Transaction** — `3fb0f496f209507098e6439c646a60d6a576de856a28afbb4f44598b77dc512f`
- **Ledger** — 4033690
- **Memo hash** — Equals the sealed Merkle root
- **Fee** — 100 stroops
- **Explorer** — https://stellar.expert/explorer/testnet/tx/3fb0f496f209507098e6439c646a60d6a576de856a28afbb4f44598b77dc512f

## Support

For operational issues, see [Runbook](docs/runbook.md).  
For verification questions, see [Verification](docs/verification.md).  
For architecture questions, see [Architecture](docs/architecture.md).

## License

MIT
