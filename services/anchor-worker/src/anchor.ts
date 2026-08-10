import {
  BASE_FEE,
  Horizon,
  Keypair,
  Memo,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

/**
 * Classic Stellar anchoring (testnet).
 *
 * Given a sealed batch's 32-byte Merkle root, write it to the ledger so a third
 * party can independently verify it, cheaply.
 *
 * Why the classic layer and not Soroban:
 *   - It is the cheapest primitive that proves tamper-evidence (base fee
 *     0.00001 XLM, ~5s settlement).
 *   - Soroban InvokeHostFunctionOp transactions cannot carry a memo, so the
 *     raw audit trail belongs on classic. Soroban is reserved for stateful
 *     credit logic post-pilot, where typed contract storage earns its keep.
 *
 * The root is written twice, in two independent places:
 *   - a `manageData` entry (value capped at 64 bytes; a 32-byte root fits), which
 *     persists as queryable account state, and
 *   - a `MEMO_HASH`, which is part of the transaction record itself.
 * Either one alone proves the anchor; together they survive an account's data
 * entry later being overwritten.
 */

export interface AnchorResult {
  stellarTxHash: string;
  stellarLedger: number;
  network: "testnet" | "public";
  dataEntryKey: string;
  anchoredAt: string;
}

export interface AnchorConfig {
  horizonUrl: string;
  networkPassphrase: string;
  secret: string;
}

export function loadAnchorConfig(env: NodeJS.ProcessEnv = process.env): AnchorConfig {
  const secret = env.STELLAR_SECRET;
  if (!secret) {
    throw new Error(
      "STELLAR_SECRET is not set — run `npm run create-account -w @proofchain/anchor-worker` to fund a testnet key",
    );
  }
  return {
    horizonUrl: env.STELLAR_HORIZON_URL ?? "https://horizon-testnet.stellar.org",
    networkPassphrase: env.STELLAR_NETWORK_PASSPHRASE ?? Networks.TESTNET,
    secret,
  };
}

/** manageData keys are capped at 64 bytes; a UUID batch id leaves room to spare. */
export function dataEntryKeyFor(batchId: string): string {
  const key = `proofchain:batch:${batchId}`;
  if (Buffer.byteLength(key, "utf8") > 64) {
    throw new Error(`data entry key exceeds 64 bytes: ${key}`);
  }
  return key;
}

export function assertRoot(merkleRootHex: string): Buffer {
  if (!/^[0-9a-f]{64}$/.test(merkleRootHex)) {
    throw new Error(`expected a 32-byte lowercase hex Merkle root, got: ${merkleRootHex}`);
  }
  return Buffer.from(merkleRootHex, "hex");
}

function networkNameOf(passphrase: string): "testnet" | "public" {
  return passphrase === Networks.PUBLIC ? "public" : "testnet";
}

export async function anchorBatchRoot(
  merkleRootHex: string,
  batchId: string,
  config: AnchorConfig,
): Promise<AnchorResult> {
  const root = assertRoot(merkleRootHex);
  const dataEntryKey = dataEntryKeyFor(batchId);

  const server = new Horizon.Server(config.horizonUrl);
  const source = Keypair.fromSecret(config.secret);

  // Sequence numbers advance per transaction; always reload before building.
  const account = await server.loadAccount(source.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(Operation.manageData({ name: dataEntryKey, value: root }))
    .addMemo(Memo.hash(root))
    .setTimeout(90)
    .build();

  tx.sign(source);

  const response = await server.submitTransaction(tx);

  // `successful`/`ledger` are non-optional on HorizonApi.SubmitTransactionResponse.
  // A resolved submitTransaction() call always represents an applied transaction
  // (Horizon returns a non-2xx status — which the SDK turns into a rejection —
  // for anything that did not make it into a ledger), but we still guard the
  // invariant explicitly rather than silently coercing a missing/failed result
  // into the misleadingly "valid-looking" ledger number 0.
  if (!response.successful) {
    throw new Error(
      `Horizon reported an unsuccessful submission for tx ${response.hash}, refusing to treat it as anchored`,
    );
  }

  return {
    stellarTxHash: response.hash,
    stellarLedger: response.ledger,
    network: networkNameOf(config.networkPassphrase),
    dataEntryKey,
    anchoredAt: new Date().toISOString(),
  };
}

export interface LedgerVerification {
  txFound: boolean;
  memoMatches: boolean;
  dataEntryMatches: boolean;
  ledger: number | null;
  /** True only when the ledger independently confirms the expected root. */
  verified: boolean;
}

/**
 * Read the anchor back off the ledger and compare it to the root we hold.
 *
 * This is the step that makes the claim falsifiable: we do not trust our own
 * submit response, we re-read what the network actually recorded.
 */
export async function verifyAnchorOnLedger(
  txHash: string,
  expectedRootHex: string,
  accountPublicKey: string,
  dataEntryKey: string,
  config: Pick<AnchorConfig, "horizonUrl">,
): Promise<LedgerVerification> {
  const server = new Horizon.Server(config.horizonUrl);

  let memoMatches = false;
  let ledger: number | null = null;
  let txFound = false;

  try {
    const tx = await server.transactions().transaction(txHash).call();
    txFound = true;
    // `ledger_attr` is the number; `ledger` on this record is a link-follow fn.
    ledger = Number(tx.ledger_attr ?? 0) || null;

    // MEMO_HASH comes back base64-encoded.
    if (tx.memo_type === "hash" && typeof tx.memo === "string") {
      memoMatches = Buffer.from(tx.memo, "base64").toString("hex") === expectedRootHex;
    }
  } catch {
    txFound = false;
  }

  let dataEntryMatches = false;
  try {
    const account = await server.loadAccount(accountPublicKey);
    const value = account.data_attr?.[dataEntryKey];
    if (typeof value === "string") {
      dataEntryMatches = Buffer.from(value, "base64").toString("hex") === expectedRootHex;
    }
  } catch {
    dataEntryMatches = false;
  }

  return {
    txFound,
    memoMatches,
    dataEntryMatches,
    ledger,
    // Either independent reference proving the root is sufficient; the data
    // entry can legitimately be overwritten by a later batch on the same account.
    verified: txFound && (memoMatches || dataEntryMatches),
  };
}
