use soroban_sdk::{contractevent, Address, BytesN};

/// Published when a sealed batch enters the registry.
///
/// Off-chain indexers (and the dashboard's verification page) should be able to
/// reconstruct the registry from the event stream alone, without a contract
/// read per batch — so the event carries the full record, not just the id.
///
/// `batch_id` and `issuer` are topics: those are the two axes anyone actually
/// filters on ("show me this batch" / "show me this collector's batches").
/// `root` is deliberately *not* a topic — nobody queries by root, they compare
/// against one they already computed, and topics are the scarcer resource.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchRegistered {
    #[topic]
    pub batch_id: BytesN<32>,
    #[topic]
    pub issuer: Address,
    pub root: BytesN<32>,
    pub weight_g: u64,
    pub registered_ledger: u32,
}

/// Published when credits are issued against a batch, exactly once per batch.
///
/// This is the event a credit registry or auditor watches: its absence is the
/// proof that a batch has *not* been monetised yet.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BatchCredited {
    #[topic]
    pub batch_id: BytesN<32>,
    #[topic]
    pub issuer: Address,
    pub weight_g: u64,
    pub credited_ledger: u32,
}

/// Published on `initialize`, so an indexer can pin the admin from history.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Initialized {
    #[topic]
    pub admin: Address,
}

/// Published on issuer allow-list changes. Governance changes are exactly the
/// thing an auditor will want a timeline of.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IssuerAdded {
    #[topic]
    pub issuer: Address,
}

#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IssuerRemoved {
    #[topic]
    pub issuer: Address,
}
