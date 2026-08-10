use soroban_sdk::contracterror;

/// Typed failures.
///
/// A bare `panic!` in a Soroban contract surfaces to the caller as an opaque
/// `WasmVm(InvalidAction)` — the backend would have no way to tell "this batch
/// was already anchored" (benign, idempotent retry) from "this caller is not an
/// issuer" (a real misconfiguration). `#[contracterror]` puts a stable numeric
/// code in the transaction result instead, so the anchor worker can branch on it.
///
/// Codes are part of the contract's ABI: append new variants, never renumber.
#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum Error {
    /// `initialize` was called on a contract that already has an admin.
    AlreadyInitialized = 1,
    /// Any call before `initialize` — refuse rather than default to an open registry.
    NotInitialized = 2,
    /// Caller authenticated fine but is not the admin / not an allow-listed issuer.
    NotAuthorized = 3,
    /// The double-anchor guard: this batch id is already in the registry.
    BatchAlreadyRegistered = 4,
    /// `get`-adjacent mutations on a batch that was never registered.
    BatchNotFound = 5,
    /// The double-counting guard: credits were already issued against this batch.
    AlreadyCredited = 6,
    /// A sealed batch with zero mass is a bug upstream, not a valid record.
    InvalidWeight = 7,
    /// The admin cannot be removed from the issuer set by accident, and an
    /// issuer cannot be added twice — keeps the allow-list a true set.
    IssuerAlreadyAdded = 8,
    /// Removing an address that was never an issuer is almost always a typo in
    /// a key, which we would rather surface than silently succeed.
    IssuerNotFound = 9,
}
