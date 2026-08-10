use soroban_sdk::{panic_with_error, Address, BytesN, Env};

use crate::error::Error;
use crate::types::{BatchRecord, DataKey};

/// Why *persistent* storage and not temporary, for every entry in this contract:
///
/// Temporary entries are deleted when their TTL lapses and can never be brought
/// back. An audit record whose whole purpose is to be checkable years later
/// cannot live there. Persistent entries, once their TTL lapses, are *archived*
/// rather than destroyed — the data stays in the network's history and a later
/// transaction can pay to restore it (`RestoreFootprintOp`). That is the only
/// storage class with the durability an audit trail needs.
///
/// Persistent storage is not free-forever though: it still has rent, so every
/// write path below re-extends the TTL of what it touched. We extend to the
/// network maximum rather than a hardcoded ledger count, because the cap is a
/// network setting that has changed before and a hardcoded value that exceeds
/// it makes the host reject the call outright.
fn bump_persistent<K>(env: &Env, key: &K)
where
    K: soroban_sdk::IntoVal<Env, soroban_sdk::Val>,
{
    let max = env.storage().max_ttl();
    // Only pay for the extension once the entry has burned through half its
    // life. Extending on every touch when it is already near-max would spend
    // rent for ledgers the entry already had.
    env.storage().persistent().extend_ttl(key, max / 2, max);
}

/// The admin lives in instance storage: it is read on nearly every governance
/// call, and instance storage is loaded with the contract anyway, so it costs
/// nothing extra to read. Its TTL rides along with the contract instance, which
/// must be alive for the contract to be invocable at all.
pub fn set_admin(env: &Env, admin: &Address) {
    env.storage().instance().set(&DataKey::Admin, admin);
    bump_instance(env);
}

pub fn get_admin(env: &Env) -> Option<Address> {
    env.storage().instance().get(&DataKey::Admin)
}

/// Reads the admin or aborts. Refusing to act while uninitialised is deliberate:
/// the failure mode of the alternative (treat "no admin" as "anyone may write")
/// is an open registry, which is unrecoverable once a bogus batch is anchored.
pub fn require_admin_set(env: &Env) -> Address {
    match get_admin(env) {
        Some(admin) => admin,
        None => panic_with_error!(env, Error::NotInitialized),
    }
}

pub fn bump_instance(env: &Env) {
    let max = env.storage().max_ttl();
    env.storage().instance().extend_ttl(max / 2, max);
}

pub fn is_issuer(env: &Env, addr: &Address) -> bool {
    env.storage().persistent().has(&DataKey::Issuer(addr.clone()))
}

pub fn add_issuer(env: &Env, addr: &Address) {
    let key = DataKey::Issuer(addr.clone());
    // The value is meaningless; presence of the key is the whole signal. Storing
    // `true` keeps the entry a well-formed ScVal without inventing a struct.
    env.storage().persistent().set(&key, &true);
    bump_persistent(env, &key);
}

pub fn remove_issuer(env: &Env, addr: &Address) {
    env.storage()
        .persistent()
        .remove(&DataKey::Issuer(addr.clone()));
}

pub fn get_batch(env: &Env, batch_id: &BytesN<32>) -> Option<BatchRecord> {
    let key = DataKey::Batch(batch_id.clone());
    let record: Option<BatchRecord> = env.storage().persistent().get(&key);
    if record.is_some() {
        // A read is the cheapest opportunity to keep an audit record from
        // drifting toward archival: anything anyone still cares about is being
        // looked at, so looking at it renews it.
        bump_persistent(env, &key);
    }
    record
}

pub fn has_batch(env: &Env, batch_id: &BytesN<32>) -> bool {
    env.storage()
        .persistent()
        .has(&DataKey::Batch(batch_id.clone()))
}

pub fn set_batch(env: &Env, batch_id: &BytesN<32>, record: &BatchRecord) {
    let key = DataKey::Batch(batch_id.clone());
    env.storage().persistent().set(&key, record);
    bump_persistent(env, &key);
}
