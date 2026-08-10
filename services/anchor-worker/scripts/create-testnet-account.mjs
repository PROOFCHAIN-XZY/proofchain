// Generate a Stellar TESTNET keypair and fund it via Friendbot.
//
//   node scripts/create-testnet-account.mjs
//
// Then copy the printed secret into services/anchor-worker/.env as STELLAR_SECRET.
// Testnet lumens have no value; never reuse this key on the public network.

import { Keypair } from "@stellar/stellar-sdk";

const keypair = Keypair.random();

console.log("Public :", keypair.publicKey());
console.log("Secret :", keypair.secret());

const response = await fetch(
  `https://friendbot.stellar.org?addr=${encodeURIComponent(keypair.publicKey())}`,
);

if (!response.ok) {
  console.error("Friendbot funding failed:", response.status, await response.text());
  process.exit(1);
}

console.log("\nFunded on testnet via Friendbot.");
console.log(`STELLAR_SECRET=${keypair.secret()}`);
