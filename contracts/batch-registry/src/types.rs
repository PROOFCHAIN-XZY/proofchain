use soroban_sdk::{contracttype, Address, BytesN};

/// A sealed batch as the ledger remembers it.
///
/// This mirrors the sealed-batch shape the backend already holds off-chain; the
/// point of duplicating it on-chain is that `credited` becomes a fact the
/// network enforces rather than a column an operator could flip twice.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchRecord {
    /// Merkle root over the batch's canonicalised weigh-in events.
    pub root: BytesN<32>,
    /// Total mass in **grams**. Integers only: a float total would make two
    /// independently-computed audits disagree in the last bits, and "did these
    /// two systems record the same batch" is the entire product.
    pub weight_g: u64,
    /// The issuer that recorded the batch — kept so a verifier can tell which
    /// key vouched for the root without replaying the whole event stream.
    pub issuer: Address,
    /// Ledger sequence at registration. Cheaper and less spoofable than a
    /// caller-supplied timestamp, and enough to order batches for an auditor.
    pub registered_ledger: u32,
    /// Set exactly once by `mark_credited`. The double-counting guard.
    pub credited: bool,
    /// Ledger sequence at which credits were issued; `None` until then.
    pub credited_ledger: Option<u32>,
}

/// Storage keys.
///
/// An enum (rather than ad-hoc symbols) means the key space is exhaustive and
/// visible in one place — a typo becomes a compile error instead of a silently
/// separate storage slot.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DataKey {
    /// The single administrator that manages the issuer allow-list.
    Admin,
    /// Presence of this key means the address may register and credit batches.
    /// Keyed per-address rather than one `Vec<Address>` so adding an issuer
    /// never rewrites (and never contends on) a single growing entry.
    Issuer(Address),
    /// One entry per sealed batch, keyed by the 32-byte batch id.
    Batch(BytesN<32>),
}
