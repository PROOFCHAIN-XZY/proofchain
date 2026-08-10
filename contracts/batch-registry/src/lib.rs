#![no_std]
//! ProofChain batch registry — the post-pilot Soroban half of the anchoring story.
//!
//! # How this relates to the classic-layer anchor that ships today
//!
//! The MVP anchors each sealed batch's Merkle root on the **classic** Stellar
//! layer (`manageData` + `MEMO_HASH`; see `services/anchor-worker/src/anchor.ts`).
//! That stays. It is the cheapest primitive that proves tamper-evidence, and —
//! decisively — a Soroban `InvokeHostFunctionOp` transaction **cannot carry a
//! memo**. The memo is one of the two independent references that make a classic
//! anchor verifiable from the transaction record itself, so moving the raw audit
//! trail to Soroban would *lose* evidence, not add any.
//!
//! What Soroban buys instead is the thing classic cannot express: typed, stateful
//! storage with contract-enforced invariants. Specifically the two guards that
//! matter once batches become tradeable credits:
//!
//!   1. **double-anchor** — a batch id can be registered exactly once, and
//!   2. **double-count** — a batch can be marked credited exactly once.
//!
//! Off-chain those are database constraints an operator can drop. Here they are
//! enforced by the network, which is the point.
//!
//! # Authorization model
//!
//! There is one `admin`, set once at `initialize`, whose only power is managing
//! an allow-list of issuers. Only allow-listed issuers may `register` or
//! `mark_credited`, and every one of those calls carries `require_auth()`.
//!
//! Deliberately *not* the design: "any address may register a batch". An open
//! registry lets anyone mint an unbounded number of plausible-looking batch
//! records, at which point the registry proves nothing about who weighed what —
//! and because registration is one-shot per batch id, an attacker could also
//! front-run and permanently squat the ids of real batches. Reads (`get`,
//! `is_issuer`, `admin`) are open, because verifiability is the product.

mod error;
mod events;
mod storage;
mod types;

#[cfg(test)]
mod test;

pub use error::Error;
pub use events::{BatchCredited, BatchRegistered, Initialized, IssuerAdded, IssuerRemoved};
pub use types::{BatchRecord, DataKey};

use soroban_sdk::{contract, contractimpl, panic_with_error, Address, BytesN, Env};

#[contract]
pub struct BatchRegistry;

#[contractimpl]
impl BatchRegistry {
    /// Sets the one-time administrator.
    ///
    /// Split out from deployment rather than done in a constructor so the
    /// deploy step stays identical to the classic-layer tooling we already have,
    /// and so a botched admin key is a failed `initialize` instead of a failed
    /// (and re-uploaded) deploy. Re-initialisation is rejected: silently
    /// accepting a second admin would be a complete authorization bypass.
    pub fn initialize(env: Env, admin: Address) {
        if storage::get_admin(&env).is_some() {
            panic_with_error!(&env, Error::AlreadyInitialized);
        }
        storage::set_admin(&env, &admin);
        events::Initialized {
            admin: admin.clone(),
        }
        .publish(&env);
    }

    /// The current administrator. Public so a verifier can check the registry is
    /// governed by the key they expect before trusting anything in it.
    pub fn admin(env: Env) -> Address {
        storage::require_admin_set(&env)
    }

    /// Allow-lists `issuer`. Admin-only, and the admin must prove it.
    pub fn add_issuer(env: Env, issuer: Address) {
        Self::require_admin_auth(&env);
        if storage::is_issuer(&env, &issuer) {
            panic_with_error!(&env, Error::IssuerAlreadyAdded);
        }
        storage::add_issuer(&env, &issuer);
        events::IssuerAdded {
            issuer: issuer.clone(),
        }
        .publish(&env);
    }

    /// Revokes an issuer.
    ///
    /// Note what this does *not* do: it does not touch batches the issuer already
    /// registered. Revoking a compromised key must not retroactively erase audit
    /// history — the records stay, attributed to the key that made them, which is
    /// exactly what an auditor needs to scope the damage.
    pub fn remove_issuer(env: Env, issuer: Address) {
        Self::require_admin_auth(&env);
        if !storage::is_issuer(&env, &issuer) {
            panic_with_error!(&env, Error::IssuerNotFound);
        }
        storage::remove_issuer(&env, &issuer);
        events::IssuerRemoved {
            issuer: issuer.clone(),
        }
        .publish(&env);
    }

    /// Whether `addr` may register batches. Open read; the allow-list is not a secret.
    pub fn is_issuer(env: Env, addr: Address) -> bool {
        storage::is_issuer(&env, &addr)
    }

    /// Records a sealed batch. The double-anchor guard.
    ///
    /// `weight_g` is grams as an integer for the same reason the off-chain
    /// canonicaliser uses integers: two independent parties must be able to
    /// recompute the same total and get bit-identical results. Floats cannot
    /// promise that, and Soroban has no float type anyway.
    pub fn register(env: Env, batch_id: BytesN<32>, root: BytesN<32>, weight_g: u64, issuer: Address) {
        Self::require_issuer_auth(&env, &issuer);

        if weight_g == 0 {
            // A sealed batch with no mass means the upstream aggregation is
            // broken. Anchoring it would launder that bug into the audit trail.
            panic_with_error!(&env, Error::InvalidWeight);
        }

        // The guard. `has` rather than `get` so we never pay to deserialise a
        // record we are about to reject.
        if storage::has_batch(&env, &batch_id) {
            panic_with_error!(&env, Error::BatchAlreadyRegistered);
        }

        let registered_ledger = env.ledger().sequence();
        let record = BatchRecord {
            root: root.clone(),
            weight_g,
            issuer: issuer.clone(),
            registered_ledger,
            credited: false,
            credited_ledger: None,
        };
        storage::set_batch(&env, &batch_id, &record);

        events::BatchRegistered {
            batch_id,
            issuer,
            root,
            weight_g,
            registered_ledger,
        }
        .publish(&env);
    }

    /// Reads a batch back. `None` for an unknown id.
    ///
    /// Returning `Option` rather than erroring is intentional: "is this batch in
    /// the registry?" is a legitimate question with a legitimate negative answer,
    /// and a verifier should be able to ask it without their call reverting.
    pub fn get(env: Env, batch_id: BytesN<32>) -> Option<BatchRecord> {
        storage::get_batch(&env, &batch_id)
    }

    /// Flips `credited` exactly once. The double-counting guard.
    ///
    /// This is the invariant that makes the whole contract worth deploying: once
    /// credits have been issued against a batch's mass, no second issuance can
    /// reference the same batch, no matter which issuer tries or how the
    /// off-chain bookkeeping is manipulated.
    pub fn mark_credited(env: Env, batch_id: BytesN<32>, issuer: Address) {
        Self::require_issuer_auth(&env, &issuer);

        let mut record = match storage::get_batch(&env, &batch_id) {
            Some(record) => record,
            None => panic_with_error!(&env, Error::BatchNotFound),
        };

        if record.credited {
            panic_with_error!(&env, Error::AlreadyCredited);
        }

        let credited_ledger = env.ledger().sequence();
        record.credited = true;
        record.credited_ledger = Some(credited_ledger);
        storage::set_batch(&env, &batch_id, &record);

        events::BatchCredited {
            batch_id,
            issuer,
            weight_g: record.weight_g,
            credited_ledger,
        }
        .publish(&env);
    }

    /// Admin-only gate. `require_auth` before the allow-list check so an
    /// unauthenticated caller can never reach contract state at all.
    fn require_admin_auth(env: &Env) {
        let admin = storage::require_admin_set(env);
        admin.require_auth();
    }

    /// Issuer gate: the address must both prove control of its key *and* be on
    /// the allow-list. Either alone is insufficient — auth without the
    /// allow-list is an open registry, and the allow-list without auth would let
    /// anyone submit batches in an issuer's name.
    fn require_issuer_auth(env: &Env, issuer: &Address) {
        // Also asserts the contract has been initialized; an uninitialized
        // registry has an empty allow-list and must reject everything.
        storage::require_admin_set(env);
        issuer.require_auth();
        if !storage::is_issuer(env, issuer) {
            panic_with_error!(env, Error::NotAuthorized);
        }
        // Batch writes keep the contract instance (and therefore the admin
        // entry) alive alongside the records themselves.
        storage::bump_instance(env);
    }
}
