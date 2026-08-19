# Architecture

**Technical design and data model for ProofChain.**

This document describes:
1. The database schema (9 tables)
2. The integrity v1 checks and threat model
3. Why classic Stellar and not Soroban
4. Known limitations and future work

## Data Model

The schema is designed backwards from the audit artifact. Every table exists because an auditor, a PRO, or a credit buyer will eventually ask about it.

### The 9 Tables

#### 1. Hubs (collection_points)

Physical locations where waste is collected. A hub defines:
- A geofence (latitude, longitude, radius in meters)
- Weight bounds per weigh-in (minimum, maximum in kg)

```sql
CREATE TABLE hubs (
  id uuid PRIMARY KEY,
  code varchar UNIQUE,           -- Short identifier (e.g., "nairobi-pilot")
  name varchar,                  -- "Nairobi Pilot Hub"
  lat double precision,          -- -1.286389
  lng double precision,          -- 36.817223
  geofenceRadiusM int DEFAULT 250,
  minWeightKg numeric(10,3) DEFAULT 0.1,
  maxWeightKg numeric(10,3) DEFAULT 500,
  createdAt timestamptz
);
```

**Why it matters:** Collectors must report from within the hub's geofence. Out-of-area weigh-ins indicate either GPS spoofing or collection from an unapproved location.

#### 2. Collectors (waste_collection_workers)

Individuals who collect and weigh plastic. One phone ↔ one collector. Tied to mobile-money identity for payment.

```sql
CREATE TABLE collectors (
  id uuid PRIMARY KEY,
  name varchar,
  phone varchar UNIQUE,          -- Mobile-money identity
  cooperativeId varchar,         -- Group membership (optional)
  kycLevel varchar DEFAULT 'none',  -- none | basic | verified
  homeLat double precision,
  homeLng double precision,
  active boolean DEFAULT true,
  createdAt timestamptz
);
```

**Why it matters:** Identifies who collected the waste. Phone is unique so one person is one payee. KYC level tracks identity verification for credit issuance.

#### 3. Devices (capture_devices)

Enrolled phones/scales that sign weigh-ins. Each device has an ed25519 public key; the private key stays on the device and never touches the server.

```sql
CREATE TABLE devices (
  id uuid PRIMARY KEY,
  collectorId uuid REFERENCES collectors,
  label varchar,                 -- "Phone 1" | "Scale in Hub A"
  publicKeyBase64 varchar UNIQUE,  -- Base64-encoded ed25519 public key (32 bytes)
  enrolledAt timestamptz,
  revokedAt timestamptz NULL,    -- Null = active; set to revoke without deleting
  INDEX (collectorId)
);
```

**Why it matters:** The public key is the root of trust. Each weigh-in is signed with this key. Revocation (setting `revokedAt`) invalidates all future weigh-ins from this key but doesn't retroactively invalidate already-signed events.

#### 4. Collection Events (weigh_in_records)

The atomic verified fact: one weigh-in. Every event has:
- The signed payload (schema, IDs, weight, location, photo hash, timestamp, nonce)
- The signature (ed25519, base64)
- The payload hash (sha256, for deduplication)
- Integrity verdict (outcome + array of findings)
- Quarantine flag (failed integrity → never batched)

```sql
CREATE TABLE collection_events (
  id uuid PRIMARY KEY,
  collectorId uuid REFERENCES collectors,
  hubId uuid REFERENCES hubs,
  deviceId uuid REFERENCES devices,
  batchId uuid REFERENCES batches NULL,  -- Set when added to a batch; frozen when batch seals
  weightKg numeric(10,3),
  material varchar,              -- a code from the materials catalogue (table 9)
  lat double precision,
  lng double precision,
  capturedAt timestamptz,        -- Device clock
  receivedAt timestamptz,        -- Server clock (gap = integrity signal)
  photoHash varchar,             -- sha256 of photo bytes (photo stays off-chain)
  photoUri varchar NULL,         -- Optional: link to external photo storage
  nonce varchar,                 -- Random 16 bytes hex (replay detection)
  signature text,                -- Base64 ed25519 signature
  payloadHash varchar UNIQUE,    -- sha256 of canonical payload (replay protection)
  integrity jsonb,               -- Verdict with array of findings
  quarantined boolean DEFAULT false,
  createdAt timestamptz,
  UNIQUE (payloadHash),          -- Replay protection enforced by database
  INDEX (hubId, capturedAt),
  INDEX (quarantined)
);
```

**Why it matters:** The source of truth for all weigh-ins. Integrity verdicts are attached at ingest and never change, so the audit trail is immutable.

#### 5. Batches (batch_aggregations)

Groups of events aggregated for processing. Lifecycle:
1. **open** — Operator adds events
2. **sealed** — Membership frozen, Merkle root computed
3. **processed** — Physical processing complete
4. **sold** — Credit buyer accepted

```sql
CREATE TABLE batches (
  id uuid PRIMARY KEY,
  hubId uuid REFERENCES hubs,
  material varchar,              -- a catalogue code; all events in a batch must match
  status varchar DEFAULT 'open', -- open | sealed | processed | sold
  totalWeightKg numeric(12,3) DEFAULT 0,
  eventCount int DEFAULT 0,
  merkleRoot varchar NULL,       -- Set once, at seal time
  sealedAt timestamptz NULL,
  createdAt timestamptz,
  updatedAt timestamptz,
  INDEX (status),
  INDEX (hubId, status)
);
```

**Why it matters:** Batches are the unit of sale. Sealing freezes membership and computes the Merkle root, proving that no event can be added, removed, or reordered after that point.

#### 6. Custody Transfers (chain_of_custody)

Records handoffs between parties (collector → hub → processor → buyer). Includes variance (moisture loss, contamination rejects).

```sql
CREATE TABLE custody_transfers (
  id uuid PRIMARY KEY,
  batchId uuid REFERENCES batches,
  fromParty varchar,
  toParty varchar,
  weightInKg numeric(12,3),
  weightOutKg numeric(12,3),
  varianceKg numeric(12,3),      -- weightIn - weightOut (stored, not derived)
  reason varchar NULL,           -- "moisture loss and contamination rejects"
  transferredAt timestamptz,
  createdAt timestamptz
);
```

**Why it matters:** Documents the physical journey of the waste. Variance is expected but auditable. Stored (not computed) so a later change to weights is visible.

#### 7. Anchor Records (on_chain_proofs)

Links each batch to its Stellar transaction. One per batch (1:1 relationship).

```sql
CREATE TABLE anchor_records (
  id uuid PRIMARY KEY,
  batchId uuid UNIQUE REFERENCES batches,  -- One anchor per batch
  merkleRoot varchar,
  stellarTxHash varchar UNIQUE,  -- Immutable ledger reference
  stellarLedger bigint,          -- Ledger sequence number
  network varchar DEFAULT 'testnet',  -- testnet | public
  dataEntryKey varchar,          -- "proofchain:batch:<batch_id>"
  anchoredAt timestamptz,        -- When the transaction was submitted
  createdAt timestamptz
);
```

**Why it matters:** The proof that the batch was sealed at a specific time and immutably recorded. `stellarLedger` is immutable; `stellarTxHash` is a permanent reference.

#### 8. Users (operators_and_auditors)

Operator and auditor accounts for the dashboard. Collectors authenticate by device key, not password.

```sql
CREATE TABLE users (
  id uuid PRIMARY KEY,
  email varchar UNIQUE,
  passwordHash varchar,          -- Argon2 hash
  role varchar DEFAULT 'operator',  -- admin | operator | auditor
  active boolean DEFAULT true,
  createdAt timestamptz
);
```

**Why it matters:** Operators manage batches (seal, custody). Auditors have read-only access. Admins enroll new devices.

#### 9. Materials (material_catalogue)

The material types a collector may choose from, maintained by an administrator at
runtime rather than compiled into the apps.

```sql
CREATE TABLE materials (
  code varchar(16) PRIMARY KEY,  -- "PET" — signed into payloads, permanent
  name varchar(120),             -- "Mixed plastic" — presentation only
  description varchar(300),      -- field guidance, nullable
  examples text[] DEFAULT '{}',  -- products a collector recognises: {"Milk jugs"}
  active boolean DEFAULT true,   -- false = retired, hidden from new capture
  "sortOrder" int DEFAULT 100,
  createdAt timestamptz,
  updatedAt timestamptz,
  CONSTRAINT "CHK_materials_code_shape"
    CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{1,15}$')
);
```

**Why it matters, and why it is shaped like this:** `material` is a field in the
signed weigh-in payload, so a code is hashed into the Merkle leaf and anchored on
the ledger. Three consequences follow, and every design decision here is one of
them:

1. **Codes are append-only.** There is no rename endpoint. Renaming a code that
   has been anchored would invalidate the audit report of every batch containing
   it, and no migration can fix that — the root is on a public ledger. The code is
   the primary key partly to make this structural.
2. **Retiring is not deleting.** `active: false` removes a material from the
   capture pickers and touches no stored event. Outright deletion is allowed only
   for a code no event and no batch has ever used; anything else returns 409 with
   the reference counts and a pointer to retirement.
3. **No foreign key from `collection_events.material` or `batches.material`.**
   This is deliberate. A signed material code is a historical fact, not a
   reference to current configuration, and a FK would let a catalogue edit
   cascade into — or be blocked by — anchored evidence. Existence is checked at
   ingest instead, where it can be reported as a 400.

The two gates differ on purpose:

| Path | Gate | Why |
|---|---|---|
| `POST /events` (ingest) | code must **exist** | Capture is offline-first. A phone can hold a queue signed hours ago against a catalogue that has since changed; rejecting those records would destroy already-signed field work nobody can redo. |
| `POST /batches` (open) | code must exist **and be active** | An operator is making a forward-looking choice with the live catalogue in front of them, so a retired code is a mistake to block. |

`examples` is the products a collector would name — "milk jugs", "bottle caps" —
and the capture apps show them as tags under the picker. It is presentation, like
`name` and `description`: never signed, never hashed, and safe for an operator to
correct when the local waste stream does not look like the one the seed data was
written for. Always an array, never null, so a picker has one empty state rather
than two. The list is normalised on the way in *and* on the way out, because a
device reads it from a cache it may have written before the field existed.

The six codes the pilot shipped with are seeded by the migration, and are also
compiled into `@proofchain/shared` as `SEED_MATERIALS` — the offline fallback for
a device that has never reached the backend.

## Integrity v1 Checks

Integrity checks run at ingest on every weigh-in. They are deliberately **pure** (no DB state, no crypto beyond signature verification, no system clock beyond receipt time) so every check is:
- Testable in isolation
- Identical on the server and in review tooling
- Auditable by anyone with the payload and public key

Any *fail* quarantines the event; it can never enter a batch. A *warn* is logged but doesn't block (e.g., offline sync).

### The 7 Checks

#### 1. Device Enrolled (`device_enrolled`)

**Defends against:** Using a key that is not enrolled, or from a different collector.

- Device public key must be enrolled in the database
- Device must not be revoked
- Device must belong to the collector who claims to own the weigh-in
- Collector must be active

**Outcome:** *fail* if device is unknown, revoked, or enrolled to a different collector. *fail* if collector is inactive.

#### 2. Signature Valid (`signature_valid`)

**Defends against:** Tampering with the payload after signing.

- The signature must be a valid ed25519 signature over the canonical payload
- The signature must verify against the device's enrolled public key

**Outcome:** *fail* if signature is invalid or missing.

**Note:** Canonical payload is defined in `packages/shared/src/canonical-core.ts`. All signers (mobile app, PWA, external integrations) must use the same encoding (deterministic JSON, field order) so signatures are verifiable.

#### 3. Geofence OK (`geofence_ok`)

**Defends against:** Collecting plastic from outside the hub's service area (implies either GPS spoofing or unauthorized collection).

- The weigh-in's latitude and longitude must be valid coordinates
- The hub must exist
- The event's location must be within the hub's geofence (great-circle distance ≤ radius)

**Outcome:** *fail* if coordinates are invalid, hub is unknown, or distance exceeds the geofence radius.

**Tolerance:** The `hubs.geofence_radius_m` column defaults to 250 m; the seeded Nairobi Pilot Hub sets 300 m explicitly, and each hub is expected to be tuned to its own site. The radius has to absorb ordinary GPS jitter (±10 m in the open, far worse between buildings or under a roof) while still catching a weigh-in claimed from the wrong part of town. Set it too tight and honest collectors get quarantined; too loose and the check stops meaning anything.

#### 4. Weight in Range (`weight_in_range`)

**Defends against:** Claiming an implausible weight (e.g., 950 kg for a single weigh-in when the hub's max is 500 kg).

- Weight must be positive
- Weight must be ≥ hub's minimum (default 0.1 kg, avoids scale noise)
- Weight must be ≤ hub's maximum (default 500 kg, a single collector can't carry more)

**Outcome:** *fail* if weight is invalid, below minimum, or above maximum.

**Note:** These bounds are per-weigh-in, not per-batch. A batch can accumulate multiple weigh-ins up to any weight.

#### 5. Not a Duplicate (`not_duplicate`)

**Defends against:** Replaying an identical signed weigh-in to create credit out of thin air.

- The canonical payload hash must not already exist in the database
- (Or equivalently, the nonce must be unique per device per timestamp interval)

**Outcome:** *fail* if the payload hash is a duplicate.

**Enforcement:** The database enforces a UNIQUE constraint on `payloadHash`, so even if the check passes, a race condition replay is caught at the database layer.

**Why it works:** The nonce is random and unique per weigh-in. The payload includes the nonce. An attacker who replays the same payload (with the same nonce, weight, location, timestamp) will hash to the same payload hash and be detected. An attacker who changes the nonce must re-sign (they don't have the private key).

#### 6. Clock Plausible (`clock_plausible`)

**Defends against:** Backdated or future-dated weigh-ins (indicates either device clock drift or an attempt to forge a timestamp).

- The capturedAt timestamp must be a valid ISO-8601 datetime
- The difference between capturedAt and the server's current time must be within tolerance (default ±15 seconds)

**Outcome:** *fail* if the timestamp is invalid or future-dated beyond tolerance. *warn* if backdated beyond tolerance (e.g., offline sync after hours).

**Rationale:** 
- Future-dated is a hard fail: a device can't report a weigh-in that hasn't happened yet.
- Backdated is a warning: offline devices may sync days later, which is expected. The operator can decide whether to accept the batch based on context.

**Tolerance:** ±15 seconds accommodates NTP clock skew and network latency without being so loose that an old backdated event looks fresh.

#### 7. Photo Present (`photo_present`)

**Defends against:** Missing or invalid photo hash (indicates metadata tampering or a misconfigured device).

- The photoHash must be a valid sha256 digest (64 lowercase hex characters)

**Outcome:** *fail* if the hash is not a valid sha256.

**Note:** This check does NOT verify that the photo actually exists or that it matches the material. Photo content verification is deferred to v2 (ML-based material classification). For now, the hash is stored as a reference for later analysis.

### Integrity Verdict Format

Each event's integrity verdict is stored as a JSONB object:

```json
{
  "outcome": "pass" | "warn" | "fail",
  "findings": [
    {
      "check": "signature_valid",
      "outcome": "pass"
    },
    {
      "check": "geofence_ok",
      "outcome": "fail",
      "detail": "1250 m from hub (fence 250 m)"
    },
    ...
  ]
}
```

The overall `outcome` is:
- **pass** — All checks passed
- **warn** — At least one warning, no failures
- **fail** — At least one failure

A *fail* outcome means the event is quarantined (`quarantined = true`) and will never enter a batch. Operators can view quarantined events for debugging but cannot force them into production batches.

## Why Classic Stellar, Not Soroban

### The Problem

Stellar offers two layers:
1. **Classic** — Account-based, simple operations (`manageData`, `payment`, `setOptions`), memos, ledger finality in ~5 seconds.
2. **Soroban** — Smart contracts, complex state management, WebAssembly, 15-second finality.

Both are on the same network and use the same native token (XLM).

### The Decision

ProofChain anchors the Merkle root using **classic layer only**. Here's why:

#### 1. Stellar Transactions Cannot Carry Memos on Soroban

A Soroban `InvokeHostFunctionOp` transaction cannot have a memo field. The memo is the transaction-level metadata that carries immutable context (in ProofChain's case, the Merkle root). Without a memo, an auditor cannot easily prove that a Stellar transaction is the one that anchored this batch.

```
// Classic: Can carry memo.hash(root)
TransactionBuilder()
  .addMemo(Memo.hash(root))
  .addOperation(Operation.manageData(...))
  .build()

// Soroban: No memo support; must encode root in contract state
InvokeHostFunctionOp(...)
// root must live in contract storage, not the transaction itself
```

ProofChain needs the root to be in the transaction because:
- The transaction is the audit trail (immutable ledger record)
- A memo is cryptographically signed as part of the tx hash
- An auditor can verify the root without calling our APIs (query Horizon directly)

#### 2. Cost and Complexity

Classic `manageData` is the cheapest operation (100 stroops ≈ $0.00001 USD on testnet). Soroban operations are more expensive and require contract code to maintain registry state.

For this MVP, the simpler solution is correct.

#### 3. Contract Logic is Deferred to Post-Pilot

The post-pilot phase will use Soroban for:
- **Stateful credit registry** — A contract that tracks which buyers have claimed credits from which batches
- **Double-spend prevention** — The contract holds the credits and enforces "one credit = one tonne, one claim per credit"
- **Automated settling** — Smart contract logic to move credits between accounts

For now, the classic layer proves immutability. Soroban will handle the economic layer post-pilot. The two layers complement each other.

### The Implementation

The anchor is written via a classic transaction with two independent proofs:

1. **manageData operation** — Stores the root under the key `proofchain:batch:<batch_id>`, persists as queryable account state
2. **Memo.hash** — Includes the root in the transaction memo, immutable as part of the ledger record

Either one alone proves the anchor. Together, they survive an account's data entry being overwritten (e.g., on a future batch to the same account).

```typescript
// From services/anchor-worker/src/anchor.ts
const tx = new TransactionBuilder(account, {
  fee: BASE_FEE,
  networkPassphrase: config.networkPassphrase,
})
  .addOperation(Operation.manageData({ name: dataEntryKey, value: root }))
  .addMemo(Memo.hash(root))
  .setTimeout(90)
  .build();
```

## Known Limitations

### 1. Timestamp-Only Integrity

Integrity v1 does not verify photo content, material type, or weight calibration. It only checks:
- Metadata plausibility (signature, enrollment, geofence, weight bounds, timestamp)
- Absence of known tampering (no replay, valid hash format)

A rogue device with a calibrated scale can report any weight it chooses (within the hub's range). Photo hashing protects against tampering post-capture, but the photo itself is not analyzed.

**Mitigation:** Post-pilot, v2 adds ML-based material classification and volume estimation from photos.

### 2. No Behavioral Baselining

Integrity v1 has no per-collector quotas, anomaly detection, or historical baselining. A collector can theoretically submit unlimited weigh-ins.

**Mitigation:** v2 adds per-collector daily/weekly quotas and outlier detection.

### 3. No Rollback After Sealing

Once a batch is sealed, the Merkle root is computed and frozen. Events cannot be added, removed, or reordered. If an operator realizes a weigh-in should not have been included, the batch is already committed.

**Workaround:** Open a new batch and exclude the problematic event. The sealed batch remains on-chain as a historical record.

### 4. No Rate Limiting Per Device

A device can submit unlimited weigh-ins. There is no per-device quota or per-minute throttle at the ingest layer.

**Mitigation:** Operator can revoke a device. Behavioral baselining will detect anomalies (e.g., 1000 weigh-ins in one day).

### 5. Single-Thread Anchoring

The anchor worker processes one batch at a time. If sealing outpaces anchoring, batches queue in the database but are not parallelized.

**Mitigation:** Upgrade to BullMQ (Redis-backed job queue) for parallel workers.

### 6. Testnet Only

The pilot runs on Stellar testnet. Public network requires:
- Security audit of the signing contract and integrity checks
- Stellar public network account setup and funding
- Verra accreditation as a carbon credit issuer
- HTTPS/TLS for all endpoints
- Production monitoring and alerting

### 7. Stellar Ledger Finality

Stellar has 3–5 second average finality. In rare cases (cosmic radiation bit flips, protocol upgrades), a ledger can be rolled back. For carbon credits, this is acceptable (immutability is best-effort, not cryptographic certainty like Bitcoin).

## Future Enhancements

### Integrity v2

- **Photo analysis** — ML model to classify material type and estimate weight
- **Behavioral baselining** — Per-collector historical profiles, anomaly detection
- **Tamper-evident hardware** — Integration with certified scales (Bluetooth API)
- **Volume estimation** — Reject weight claims that are implausible for the reported volume

### Soroban Credit Registry (Post-Pilot)

- **Stateful credit contract** — Tracks batch → credits mapping
- **Double-spend prevention** — Each credit can be claimed once
- **Automated settling** — Move credits from issuer to buyers
- **Custody history** — On-chain audit trail of credit movement

### Infrastructure

- **Parallel anchoring** — BullMQ job queue for concurrent batch anchoring
- **Batch pagination** — Optimize large audit reports (current cap: 10,000 events)
- **Photo storage** — IPFS or S3 backend for photo persistence
- **Operator analytics** — Dashboard metrics (collection rate, recycling rate, buyer engagement)

## References

- **Stellar Documentation** — https://developers.stellar.org
- **Merkle Trees** — https://en.wikipedia.org/wiki/Merkle_tree
- **Ed25519 Signing** — https://tools.ietf.org/html/rfc8032
- **Verifiable Carbon Offsets** — https://verra.org/project/verified-carbon-standard/
