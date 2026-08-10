#![cfg(test)]
//! The behaviours asserted here are the reason the contract exists. If any of
//! them regress, the registry's guarantees ("anchored once", "credited once",
//! "only issuers write") are gone, and the on-chain record stops being evidence.
extern crate std;

use soroban_sdk::{
    testutils::{Address as _, BytesN as _, Events as _, Ledger as _},
    xdr::ScErrorType,
    Address, BytesN, Env, Event,
};

use crate::{
    BatchCredited, BatchRegistered, BatchRegistry, BatchRegistryClient, Error,
};

/// A registry with an admin and one allow-listed issuer — the state every test
/// that is not specifically about setup wants to start from.
struct Fixture<'a> {
    env: Env,
    client: BatchRegistryClient<'a>,
    contract_id: Address,
    admin: Address,
    issuer: Address,
}

fn setup() -> Fixture<'static> {
    let env = Env::default();
    // Auth is mocked wholesale for the happy paths so the tests exercise the
    // contract's *own* authorization logic (the allow-list) rather than
    // re-testing the host's signature checking. The dedicated auth test below
    // switches to enforcing mode.
    env.mock_all_auths();

    let contract_id = env.register(BatchRegistry, ());
    let client = BatchRegistryClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let issuer = Address::generate(&env);

    client.initialize(&admin);
    client.add_issuer(&issuer);

    Fixture {
        env,
        client,
        contract_id,
        admin,
        issuer,
    }
}

fn batch_id(env: &Env) -> BytesN<32> {
    BytesN::random(env)
}

/// The shape a rejected `try_*` call comes back as: the outer `Err` means the
/// invocation failed, and the inner `Ok` means it failed with one of *our* typed
/// contract errors rather than a host-level abort. Asserting on this shape is
/// how the tests prove `#[contracterror]` codes actually reach the caller.
fn rejected(e: Error) -> Result<soroban_sdk::Error, soroban_sdk::InvokeError> {
    Ok(e.into())
}

#[test]
fn registers_and_credits_a_batch() {
    let f = setup();
    let id = batch_id(&f.env);
    let root = batch_id(&f.env);

    f.env.ledger().set_sequence_number(1_000);
    f.client.register(&id, &root, &12_500u64, &f.issuer);

    let record = f.client.get(&id).expect("batch should be registered");
    assert_eq!(record.root, root);
    assert_eq!(record.weight_g, 12_500);
    assert_eq!(record.issuer, f.issuer);
    assert_eq!(record.registered_ledger, 1_000);
    assert!(!record.credited, "a fresh batch must not be credited");
    assert_eq!(record.credited_ledger, None);

    f.env.ledger().set_sequence_number(2_000);
    f.client.mark_credited(&id, &f.issuer);

    let credited = f.client.get(&id).expect("batch should still be there");
    assert!(credited.credited);
    assert_eq!(credited.credited_ledger, Some(2_000));
    // Crediting must not disturb the audit facts.
    assert_eq!(credited.root, root);
    assert_eq!(credited.weight_g, 12_500);
    assert_eq!(credited.registered_ledger, 1_000);
}

#[test]
fn rejects_duplicate_registration() {
    let f = setup();
    let id = batch_id(&f.env);
    let root = batch_id(&f.env);

    f.client.register(&id, &root, &500u64, &f.issuer);

    // Same id, different root: the second anchor must lose regardless of payload.
    let other_root = batch_id(&f.env);
    let result = f.client.try_register(&id, &other_root, &900u64, &f.issuer);
    assert_eq!(result, Err(rejected(Error::BatchAlreadyRegistered)));

    // And the original record must be untouched — a rejected re-anchor is not a
    // partial write.
    let record = f.client.get(&id).unwrap();
    assert_eq!(record.root, root);
    assert_eq!(record.weight_g, 500);
}

#[test]
fn rejects_registration_from_a_non_issuer() {
    let f = setup();
    let stranger = Address::generate(&f.env);

    let result = f
        .client
        .try_register(&batch_id(&f.env), &batch_id(&f.env), &100u64, &stranger);
    assert_eq!(result, Err(rejected(Error::NotAuthorized)));
}

#[test]
fn rejects_registration_without_authorization() {
    let f = setup();
    // Enforcing mode with an empty auth set: the issuer is allow-listed but has
    // not signed. This is the case that would let anyone submit batches in an
    // issuer's name if `require_auth` were ever dropped.
    f.env.set_auths(&[]);

    let result = f
        .client
        .try_register(&batch_id(&f.env), &batch_id(&f.env), &100u64, &f.issuer);

    // The rejection comes from the *host's* auth check, not from our allow-list:
    // the error is a Context/InvalidAction, not one of our contract codes. That
    // distinction matters — it proves `require_auth` runs before, and
    // independently of, the allow-list lookup.
    match result {
        Err(Ok(err)) => assert!(
            !err.is_type(ScErrorType::Contract),
            "expected a host auth failure, got a contract error: {err:?}"
        ),
        other => panic!("expected an unauthorized invocation to fail: {other:?}"),
    }
}

#[test]
fn rejects_double_crediting() {
    let f = setup();
    let id = batch_id(&f.env);
    f.client.register(&id, &batch_id(&f.env), &42_000u64, &f.issuer);

    f.client.mark_credited(&id, &f.issuer);

    // Same issuer trying again...
    assert_eq!(
        f.client.try_mark_credited(&id, &f.issuer),
        Err(rejected(Error::AlreadyCredited))
    );

    // ...and a *different* allow-listed issuer trying, which is the realistic
    // double-count: two operators each believing they owe the collector credits.
    let second_issuer = Address::generate(&f.env);
    f.client.add_issuer(&second_issuer);
    assert_eq!(
        f.client.try_mark_credited(&id, &second_issuer),
        Err(rejected(Error::AlreadyCredited))
    );
}

#[test]
fn rejects_crediting_from_a_non_issuer() {
    let f = setup();
    let id = batch_id(&f.env);
    f.client.register(&id, &batch_id(&f.env), &1u64, &f.issuer);

    let stranger = Address::generate(&f.env);
    assert_eq!(
        f.client.try_mark_credited(&id, &stranger),
        Err(rejected(Error::NotAuthorized))
    );
    assert!(!f.client.get(&id).unwrap().credited);
}

#[test]
fn get_on_a_missing_batch_returns_none() {
    let f = setup();
    // A verifier asking about a batch that was never anchored must get a clean
    // "no", not a reverted transaction.
    assert_eq!(f.client.get(&batch_id(&f.env)), None);
}

#[test]
fn rejects_crediting_a_missing_batch() {
    let f = setup();
    assert_eq!(
        f.client.try_mark_credited(&batch_id(&f.env), &f.issuer),
        Err(rejected(Error::BatchNotFound))
    );
}

#[test]
fn rejects_zero_weight() {
    let f = setup();
    assert_eq!(
        f.client
            .try_register(&batch_id(&f.env), &batch_id(&f.env), &0u64, &f.issuer),
        Err(rejected(Error::InvalidWeight))
    );
}

#[test]
fn stores_grams_up_to_the_full_u64_range() {
    // Grams as u64 must not quietly saturate; a tonne-scale pilot is nowhere
    // near the limit, but the type's promise should be tested at its edge.
    let f = setup();
    let id = batch_id(&f.env);
    f.client.register(&id, &batch_id(&f.env), &u64::MAX, &f.issuer);
    assert_eq!(f.client.get(&id).unwrap().weight_g, u64::MAX);
}

#[test]
fn rejects_reinitialization() {
    let f = setup();
    let usurper = Address::generate(&f.env);
    assert_eq!(
        f.client.try_initialize(&usurper),
        Err(rejected(Error::AlreadyInitialized))
    );
    assert_eq!(f.client.admin(), f.admin);
}

#[test]
fn rejects_use_before_initialization() {
    let env = Env::default();
    env.mock_all_auths();
    let client = BatchRegistryClient::new(&env, &env.register(BatchRegistry, ()));
    let someone = Address::generate(&env);

    // An uninitialized registry must be closed, not open.
    assert_eq!(
        client.try_register(&BytesN::random(&env), &BytesN::random(&env), &1u64, &someone),
        Err(rejected(Error::NotInitialized))
    );
    assert_eq!(client.try_admin(), Err(rejected(Error::NotInitialized)));
}

#[test]
fn only_the_admin_manages_the_issuer_list() {
    let f = setup();
    let candidate = Address::generate(&f.env);

    // With all auths mocked, a non-admin caller cannot even express the intent:
    // `add_issuer` takes no caller argument, so the only authority it can check
    // is the stored admin. Assert the stored admin is the one being asked.
    f.client.add_issuer(&candidate);
    // Read the auth record before any further call: `env.auths()` reports only the
    // most recent invocation, and `is_issuer` is a read that requires no auth, so
    // asserting after it would always see an empty list.
    let auths = f.env.auths();
    assert_eq!(auths.len(), 1);
    assert_eq!(auths[0].0, f.admin, "add_issuer must require the admin's auth");
    assert!(f.client.is_issuer(&candidate));

    // Adding twice is a set violation and is rejected.
    assert_eq!(
        f.client.try_add_issuer(&candidate),
        Err(rejected(Error::IssuerAlreadyAdded))
    );

    // Removing an unknown address is surfaced rather than silently accepted.
    let never_added = Address::generate(&f.env);
    assert_eq!(
        f.client.try_remove_issuer(&never_added),
        Err(rejected(Error::IssuerNotFound))
    );
}

#[test]
fn revoking_an_issuer_stops_writes_but_preserves_history() {
    let f = setup();
    let id = batch_id(&f.env);
    let root = batch_id(&f.env);
    f.client.register(&id, &root, &7_000u64, &f.issuer);

    f.client.remove_issuer(&f.issuer);
    assert!(!f.client.is_issuer(&f.issuer));

    // No new writes from the revoked key...
    assert_eq!(
        f.client
            .try_register(&batch_id(&f.env), &batch_id(&f.env), &1u64, &f.issuer),
        Err(rejected(Error::NotAuthorized))
    );
    assert_eq!(
        f.client.try_mark_credited(&id, &f.issuer),
        Err(rejected(Error::NotAuthorized))
    );

    // ...but the record it already made stays, still attributed to it. Revoking
    // a key must not erase audit history.
    let record = f.client.get(&id).unwrap();
    assert_eq!(record.root, root);
    assert_eq!(record.issuer, f.issuer);
}

#[test]
fn emits_a_register_event() {
    let f = setup();
    let id = batch_id(&f.env);
    let root = batch_id(&f.env);
    f.env.ledger().set_sequence_number(4_242);

    f.client.register(&id, &root, &9_100u64, &f.issuer);

    // Off-chain indexers reconstruct the registry from this stream, so the event
    // must carry the whole record, not just the id.
    let expected = BatchRegistered {
        batch_id: id.clone(),
        issuer: f.issuer.clone(),
        root: root.clone(),
        weight_g: 9_100,
        registered_ledger: 4_242,
    };
    assert_eq!(
        f.env.events().all(),
        std::vec![expected.to_xdr(&f.env, &f.contract_id)]
    );
}

#[test]
fn emits_a_credit_event() {
    let f = setup();
    let id = batch_id(&f.env);
    f.client.register(&id, &batch_id(&f.env), &3_300u64, &f.issuer);

    f.env.ledger().set_sequence_number(5_555);
    f.client.mark_credited(&id, &f.issuer);

    let expected = BatchCredited {
        batch_id: id.clone(),
        issuer: f.issuer.clone(),
        weight_g: 3_300,
        credited_ledger: 5_555,
    };
    assert_eq!(
        f.env.events().all(),
        std::vec![expected.to_xdr(&f.env, &f.contract_id)]
    );
}

#[test]
fn emits_no_event_when_a_call_is_rejected() {
    let f = setup();
    let id = batch_id(&f.env);
    f.client.register(&id, &batch_id(&f.env), &100u64, &f.issuer);

    let _ = f.client.try_register(&id, &batch_id(&f.env), &200u64, &f.issuer);

    // A failed invocation emits nothing, so an indexer can treat every
    // `BatchRegistered` it sees as a committed anchor.
    assert!(f.env.events().all().events().is_empty());
}

#[test]
fn records_survive_a_ttl_extension_window() {
    // Persistent storage plus `extend_ttl` is what keeps an audit record
    // readable long after the batch was sealed. Advance the ledger well past a
    // temporary entry's lifetime and assert the record is still there.
    let f = setup();
    let id = batch_id(&f.env);
    let root = batch_id(&f.env);
    f.client.register(&id, &root, &6_000u64, &f.issuer);

    let max_ttl = f.env.ledger().get().max_entry_ttl;
    f.env.ledger().set_sequence_number(max_ttl / 2);

    let record = f.client.get(&id).expect("audit record must not expire");
    assert_eq!(record.root, root);
}
