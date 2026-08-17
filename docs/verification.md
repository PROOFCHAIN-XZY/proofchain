# Verification Guide

**How an auditor independently verifies a ProofChain batch without trusting ProofChain.**

This guide walks through downloading an audit report and verifying:
1. The Merkle tree structure (all events hash together correctly)
2. One event's Merkle proof (event is in the tree)
3. The Stellar anchor (the root was committed to the ledger)

All verification can be done locally with `curl` and `node`, without creating an account or holding our encryption keys.

## Overview

ProofChain's guarantee is:
- **Integrity** — The batch membership and order cannot be changed after sealing.
- **Immutability** — The Merkle root is anchored on Stellar, providing a tamper-evident timestamp.
- **Verifiability** — Any third party can independently check both the local Merkle tree and the Stellar ledger.

The audit report contains everything needed: the event list, the sealed root, Merkle proofs, and the Stellar transaction reference. The buyer does not need to trust ProofChain's claims — they verify the facts directly.

## Step 1: Get the Batch ID

Batches are created by operators, but the audit report is **public and requires no authentication**.

If you already have a batch ID (e.g., from an email or contract), skip to Step 2.

To list all batches (public endpoint):

```bash
curl http://localhost:3000/batches | jq '.[]' | head -20
```

(If accessing a remote ProofChain, replace `localhost:3000` with the actual URL.)

Pick a batch and note its `id` (a UUID). For this guide, we'll use:

```bash
BATCH_ID="00000000-0000-0000-0000-000000000001"
```

(Replace with your actual batch ID.)

## Step 2: Download the Audit Report

```bash
curl http://localhost:3000/batches/$BATCH_ID/report > report.json
```

Inspect the report structure:

```bash
jq 'keys' report.json
```

Expected keys:

```json
[
  "reportVersion",
  "batch",
  "events",
  "proof",
  "onChain",
  "reconciliation"
]
```

### Report Fields

- **reportVersion** — Schema version (currently "v1")
- **batch** — The sealed batch metadata (ID, material, total weight, event count)
- **events** — Array of all events with their payloads, hashes, and Merkle proofs
- **proof** — The Merkle tree structure: sealed root, recomputed root, proof validity
- **onChain** — Stellar transaction reference (if anchored) or null
- **reconciliation** — Chain-of-custody variance tracking

### Check the Sealed Root and Event Count

```bash
jq '.batch' report.json
```

Expected output:

```json
{
  "id": "00000000-0000-0000-0000-000000000001",
  "material": "PET",
  "totalWeightKg": 125.3,
  "totalWeightTonnes": 0.1253,
  "eventCount": 9,
  "sealedAt": "2024-08-08T14:35:10.123Z"
}
```

The `eventCount` tells you how many events are in the tree. The `totalWeightKg` is the sum of all weights.

### Note the Merkle Root

```bash
jq '.proof.merkleRoot' report.json
```

This is the sealed root written to Stellar. It's a 64-character hex string (256 bits).

## Step 3: Verify the Merkle Tree Locally

The report includes an array of events with their Merkle proofs. You can independently recompute the root from the event list.

### Download the Shared Library

ProofChain provides a shared library (open source) with Merkle tree verification:

```bash
npm install @proofchain/shared
```

Or use the one from this repo:

```bash
cd packages/shared && npm install
```

### Verify One Event's Proof

Create a verification script `verify.js`:

```javascript
const { verifyMerkleProof } = require('@proofchain/shared');

const report = require('./report.json');

// Pick the first event
const event = report.events[0];
const root = report.proof.merkleRoot;

console.log(`Event ID: ${event.eventId}`);
console.log(`Event leaf: ${event.leaf}`);
console.log(`Sealed root: ${root}`);
console.log(`Merkle proof steps: ${event.merkleProof.length}`);

// Verify
const valid = verifyMerkleProof(event.leaf, event.merkleProof, root);

console.log(`\nProof valid: ${valid}`);

if (!valid) {
  console.error('ERROR: Merkle proof does not verify!');
  process.exit(1);
}

console.log('✓ Event proof is valid.');
```

Run it:

```bash
node verify.js
```

Expected output:

```
Event ID: 00000000-0000-0000-0000-000000000001
Event leaf: 9a3c8e...
Sealed root: 7f2d1a...
Merkle proof steps: 4

Proof valid: true
✓ Event proof is valid.
```

### Recompute the Entire Root

To verify the root matches the event list, recompute it from scratch:

```javascript
const { merkleRootHex, hashLeaf } = require('@proofchain/shared');

const report = require('./report.json');

// Compute leaf hashes for each event's payload
const leaves = report.events.map(event => event.leaf);

console.log(`Events: ${leaves.length}`);
console.log(`Event 1 leaf: ${leaves[0]}`);

// Recompute the root
const recomputedRoot = merkleRootHex(leaves);
const sealedRoot = report.proof.merkleRoot;

console.log(`\nSealed root:     ${sealedRoot}`);
console.log(`Recomputed root: ${recomputedRoot}`);
console.log(`Match: ${recomputedRoot === sealedRoot}`);

if (recomputedRoot !== sealedRoot) {
  console.error('ERROR: Roots do not match! The batch may have been tampered with.');
  process.exit(1);
}

console.log('✓ All events hash to the sealed root.');
```

Run it:

```bash
node verify-root.js
```

If the roots match, you have verified that:
1. The event list hasn't been modified since sealing
2. The Merkle tree structure is correct

## Step 4: Verify the Stellar Anchor

The audit report includes the on-chain Stellar reference. You can independently fetch the transaction from the Stellar ledger and verify it contains the root.

### Get the Stellar Transaction

```bash
jq '.onChain' report.json
```

Expected output (if anchored):

```json
{
  "network": "testnet",
  "txHash": "3fb0f496f209507098e6439c646a60d6a576de856a28afbb4f44598b77dc512f",
  "ledger": 4033690,
  "explorerUrl": "https://stellar.expert/explorer/testnet/tx/3fb0f496f209507098e6439c646a60d6a576de856a28afbb4f44598b77dc512f"
}
```

If `onChain` is null, the batch has not yet been anchored (it's still sealed but pending).

### Read ProofChain's own ledger check — then ignore it

Since the read-back was added, `onChain.ledgerConfirmation` reports what Horizon told *our* server when the report was rendered:

```json
{
  "rootMatchesLedger": true,
  "memoMatches": true,
  "dataEntryMatches": false,
  "checkedAt": "2026-03-01T12:04:11.921Z",
  "detail": "ledger confirms the sealed root (memo=true, dataEntry=false)"
}
```

Three values are possible, and the difference matters:

| `rootMatchesLedger` | Meaning |
|---|---|
| `true` | Horizon returned the anchoring transaction and it carries this root. |
| `false` | Horizon answered, and the root it carries is **not** this one — or there is no such transaction. Treat the batch as unproven and escalate. |
| `null` | Horizon could not be reached. This says nothing about the batch. |

`dataEntryMatches: false` alongside `memoMatches: true` is normal, not a warning: the `manageData` entry is overwritten by whichever batch that account anchored most recently, while the memo stays on the transaction permanently.

**This field is a convenience, not evidence.** It is ProofChain reporting on ProofChain. A batch is only independently verified when *you* run the Horizon queries below and compare the bytes yourself. The steps that follow are the ones that actually settle the question — the field above just tells you whether they are likely to.

You can also ask for the same check on its own, without rendering the whole report:

```bash
curl http://localhost:3000/batches/$BATCH_ID/ledger | jq '.confirmation'
```

### Fetch the Transaction from Horizon

Using the tx hash, query Stellar's public ledger:

```bash
TX_HASH="3fb0f496f209507098e6439c646a60d6a576de856a28afbb4f44598b77dc512f"
HORIZON="https://horizon-testnet.stellar.org"

curl "$HORIZON/transactions/$TX_HASH" > tx.json
```

### Verify the Memo Hash

The Merkle root is embedded in the transaction memo as a `MEMO_HASH`:

```bash
jq '.memo_type, .memo' tx.json
```

Expected output:

```
"hash"
"nwPIHlv8MFcJjkZIzGyOEZe3qA0="
```

The memo is base64-encoded. Decode it and compare to the root:

```bash
# Base64-decode the memo
MEMO_B64=$(jq -r '.memo' tx.json)
MEMO_HEX=$(echo "$MEMO_B64" | base64 -d | xxd -p -c 32)

# Get the sealed root from the report
SEALED_ROOT=$(jq -r '.proof.merkleRoot' report.json)

echo "Stellar memo (hex):  $MEMO_HEX"
echo "Sealed root (hex):   $SEALED_ROOT"
echo "Match: $([ "$MEMO_HEX" = "$SEALED_ROOT" ] && echo 'YES' || echo 'NO')"
```

If they match, the Stellar ledger confirms the root.

### Verify the Data Entry

The root is also stored in the transaction's `manageData` operation, accessible via the sender's account:

```bash
jq '.operations[] | select(.type == "manage_data")' tx.json
```

Expected output:

```json
{
  "type": "manage_data",
  "name": "proofchain:batch:00000000-0000-0000-0000-000000000001",
  "value": "nwPIHlv8MFcJjkZIzGyOEZe3qA0="
}
```

The data entry key includes the batch ID. The value (base64) is the same root. This provides an additional, independent reference to the root that survives account data rotation.

### Verify the Ledger Sequence

The transaction is immutable once included in a ledger. Check the ledger number:

```bash
jq '.ledger_attr' tx.json
```

This is a past ledger (immutable in Stellar). You can verify it on the public explorer:

```bash
echo "https://stellar.expert/explorer/testnet/tx/3fb0f496f209507098e6439c646a60d6a576de856a28afbb4f44598b77dc512f"
# (Replace tx hash with your own)
```

## Step 4b: Verify the Weigh-in Photos

Each event in the report carries `photoHash` — a sha256 the capture device signed into the payload alongside the weight and the location. Where `photoAvailable` is `true`, ProofChain also holds the bytes and will serve them.

```bash
jq '.events[0] | {eventId, photoHash, photoAvailable, photoUrl}' report.json
```

Download one and recompute the digest yourself:

```bash
EVENT_ID=$(jq -r '.events[0].eventId' report.json)
curl -s "http://localhost:3000/events/$EVENT_ID/photo" -o photo.bin

sha256sum photo.bin
jq -r '.events[0].photoHash' report.json
```

The two must be identical. If they are, the image you are looking at is the one the collector's device photographed and signed at capture time — not one substituted afterwards, because a substituted photo would have to hash to a value fixed before the substitution.

**What this proves, and what it does not.** It proves the image is the one signed at capture. It does *not* prove the image depicts the material claimed, that it was taken at that moment, or that it was not itself staged. Photo *content* analysis is out of scope for this release; the check above is about provenance only.

`photoAvailable: false` means the bytes were never uploaded — usually a phone that has not finished syncing over a poor link. The weigh-in is still valid: it is signed, geofenced and in the Merkle tree. Only this particular corroboration is missing, and the digest is still published, so an auditor who obtains the original photo by other means can verify it against the report.

## Step 5: Check the Audit Report Endpoint

Alternatively, ProofChain provides a verification endpoint that does some of this work for you:

```bash
curl http://localhost:3000/batches/$BATCH_ID/verify/$EVENT_ID | jq '.'
```

Where `$EVENT_ID` is one event's ID from the report.

Expected response:

```json
{
  "eventId": "00000000-0000-0000-0000-000000000002",
  "batchId": "00000000-0000-0000-0000-000000000001",
  "leaf": "9a3c8e...",
  "proof": [
    { "hash": "f1d2e...", "side": "right" },
    { "hash": "e3b0c...", "side": "left" }
  ],
  "merkleRoot": "7f2d1a...",
  "proofValid": true,
  "onChain": {
    "network": "testnet",
    "txHash": "3fb0f496f209507098e6439c646a60d6a576de856a28afbb4f44598b77dc512f",
    "ledger": 4033690,
    "explorerUrl": "https://stellar.expert/explorer/testnet/tx/3fb0f496f209507098e6439c646a60d6a576de856a28afbb4f44598b77dc512f",
    "rootMatchesLedger": true
  }
}
```

This response confirms the proof and the on-chain anchor. But again, you can verify all of this independently without trusting this endpoint — use the Merkle library and Horizon directly.

## Complete Verification Script

Here's a shell script that combines all the verification steps:

```bash
#!/bin/bash

set -e

BACKEND="${1:-http://localhost:3000}"
BATCH_ID="${2:-}"

if [ -z "$BATCH_ID" ]; then
  echo "Usage: $0 <backend_url> <batch_id>"
  echo "Example: $0 http://localhost:3000 00000000-0000-0000-0000-000000000001"
  exit 1
fi

echo "Verifying batch: $BATCH_ID"
echo "Backend: $BACKEND"
echo

# Download the report
echo "[1] Downloading audit report..."
curl -s "$BACKEND/batches/$BATCH_ID/report" > /tmp/report.json
echo "  ✓ Report downloaded"

# Check Merkle proof validity
echo "[2] Verifying Merkle proofs..."
node << 'EOF'
const { verifyMerkleProof } = require('@proofchain/shared');
const report = require('/tmp/report.json');

let allValid = true;
for (const event of report.events) {
  const valid = verifyMerkleProof(event.leaf, event.merkleProof, report.proof.merkleRoot);
  if (!valid) {
    console.error(`  ✗ Event ${event.eventId} proof INVALID`);
    allValid = false;
  }
}

if (allValid) {
  console.log(`  ✓ All ${report.events.length} proofs verified`);
} else {
  process.exit(1);
}
EOF

# Check on-chain anchor
echo "[3] Verifying Stellar anchor..."
ON_CHAIN=$(jq -r '.onChain' /tmp/report.json)

if [ "$ON_CHAIN" = "null" ]; then
  echo "  ⚠ Batch is sealed but not yet anchored (normal during initial sync)"
else
  TX_HASH=$(jq -r '.onChain.txHash' /tmp/report.json)
  SEALED_ROOT=$(jq -r '.proof.merkleRoot' /tmp/report.json)
  
  echo "  Transaction: $TX_HASH"
  
  # Fetch and verify
  HORIZON_RESP=$(curl -s "https://horizon-testnet.stellar.org/transactions/$TX_HASH")
  MEMO_B64=$(echo "$HORIZON_RESP" | jq -r '.memo // "none"')
  
  if [ "$MEMO_B64" = "none" ]; then
    echo "  ✗ Transaction not found on Stellar ledger"
    exit 1
  fi
  
  MEMO_HEX=$(echo "$MEMO_B64" | base64 -d 2>/dev/null | xxd -p -c 32)
  
  if [ "$MEMO_HEX" = "$SEALED_ROOT" ]; then
    echo "  ✓ Stellar memo matches sealed root"
  else
    echo "  ✗ Stellar memo does NOT match"
    echo "    Expected: $SEALED_ROOT"
    echo "    Got:      $MEMO_HEX"
    exit 1
  fi
fi

echo
echo "✓ Batch verified successfully."
echo "Report: $BACKEND/batches/$BATCH_ID/report"
echo "CSV export: $BACKEND/batches/$BATCH_ID/report/events.csv"
```

Save as `verify-batch.sh`, make it executable, and run:

```bash
chmod +x verify-batch.sh
./verify-batch.sh http://localhost:3000 00000000-0000-0000-0000-000000000001
```

## What If Verification Fails?

### Merkle proof is invalid

**Possible causes:**
- The event list was modified after sealing (tampered batch)
- Corruption during report transmission
- Bug in the Merkle library

**What to do:**
- Download the report again to rule out transmission errors
- Compare the report's event list to the Stellar data entry (if present)
- Contact ProofChain's security team with the batch ID and error details

### Stellar root doesn't match sealed root

**Possible causes:**
- Different Stellar network (testnet vs. public)
- The batch was not actually anchored (still pending)
- Wrong batch ID

**What to do:**
- Check `.onChain.network` — is it the network you expect?
- If `onChain` is null, the batch is pending; wait for the anchor worker to process it
- Verify the transaction URL in `.onChain.explorerUrl`

### `ledgerConfirmation.rootMatchesLedger` is null

Horizon was unreachable from ProofChain's server when the report was built — a timeout, a rate limit, or an outage. It is not a finding about the batch. Re-request the report, or skip it entirely and run the Horizon queries in Step 4 yourself; your network path to Horizon is independent of ours, which is rather the point.

### The photo's sha256 does not match photoHash

Stop and escalate. ProofChain refuses to store bytes that do not match the signed digest, so a mismatch here means either the stored file was altered after the fact on disk, or the report and the photo came from different sources. Do not accept the batch on the strength of the remaining evidence until it is explained.

### Stellar transaction not found

**Possible causes:**
- Network connectivity (can't reach Horizon)
- The tx hash is incorrect or from a different network
- Stellar ledger is still syncing

**What to do:**
- Try again after a few seconds
- Check your internet connection
- Visit the explorer URL directly in a browser
- Compare the tx hash to the report (`jq '.onChain.txHash' report.json`)

## Summary

An independent auditor can verify a ProofChain batch by:

1. **Downloading the audit report** (public, no auth required)
2. **Recomputing Merkle proofs** (using the open-source shared library)
3. **Querying Stellar Horizon** (public ledger, no trust required)
4. **Comparing the root** to the on-chain memo

All software is open source. The Merkle tree is cryptographically sound. Stellar is a public, immutable ledger. No ProofChain credentials or secrets are needed — the facts speak for themselves.
