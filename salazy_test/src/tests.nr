use aztec::protocol::address::AztecAddress;
use aztec::test::helpers::test_environment::TestEnvironment;

use salazy_contract::SalAZy;

// Minimal helper to make a padded employee array for batch issue.
fn employee_array(entries: [(AztecAddress, Field, Field); 3]) -> [SalAZy::Employee; 8] {
    let mut employees = [SalAZy::Employee { address: AztecAddress::zero(), amount: 0, role: 0 }; 8];
    for i in 0..entries.len() {
        employees[i] = SalAZy::Employee { address: entries[i].0, amount: entries[i].1, role: entries[i].2 };
    }
    employees
}

unconstrained fn setup() -> (TestEnvironment, AztecAddress, AztecAddress, AztecAddress) {
    let mut env = TestEnvironment::new();
    let alice = env.create_light_account();
    let bob = env.create_light_account();
    let carol = env.create_light_account();

    let initializer_call = SalAZy::interface().constructor();
    let contract_address =
        env.deploy("@salazy_contract/SalAZy").with_private_initializer(alice, initializer_call);

    (env, contract_address, alice, bob)
}

#[test]
unconstrained fn funding_is_private_to_the_employer() {
    let (env, contract_address, alice, bob) = setup();

    env.call_private(alice, SalAZy::at(contract_address).fund(1, 1, 1000));

    let alice_funding = env.execute_utility(SalAZy::at(contract_address).view_funding(alice, 1, 1));
    assert_eq(alice_funding, 1000);

    // Bob (a third party) cannot decrypt Alice's funding note.
    let bob_view = env.execute_utility(SalAZy::at(contract_address).view_funding(bob, 1, 1));
    assert_eq(bob_view, 0);
}

#[test]
unconstrained fn issued_salary_lands_directly_in_the_employees_balance() {
    let (env, contract_address, alice, bob) = setup();

    env.call_private(alice, SalAZy::at(contract_address).issue_salary(1, 1, bob, 100, 2));

    let notes = env.execute_utility(SalAZy::at(contract_address).view_balance_notes(bob));
    assert_eq(notes.len(), 1);
    assert_eq(notes.get(0).company, 1);
    assert_eq(notes.get(0).epoch, 1);
    assert_eq(notes.get(0).amount, 100);
    assert_eq(notes.get(0).role, 2);

    // Already credited: the balance shows the salary with no claim step.
    let balance = env.execute_utility(SalAZy::at(contract_address).view_balance(bob));
    assert_eq(balance, 100);
}

#[test]
unconstrained fn employer_cannot_read_the_employees_salary() {
    let (env, contract_address, alice, bob) = setup();

    env.call_private(alice, SalAZy::at(contract_address).issue_salary(1, 1, bob, 100, 2));

    // Alice cannot decrypt Bob's salary, even though she created it.
    let alice_notes = env.execute_utility(SalAZy::at(contract_address).view_balance_notes(alice));
    assert_eq(alice_notes.len(), 0);
}

#[test]
unconstrained fn batch_issue_pays_every_employee_in_one_tx() {
    let (env, contract_address, alice, bob, carol) = {
        let mut env = TestEnvironment::new();
        let alice = env.create_light_account();
        let bob = env.create_light_account();
        let carol = env.create_light_account();
        let initializer_call = SalAZy::interface().constructor();
        let contract_address =
            env.deploy("@salazy_contract/SalAZy").with_private_initializer(alice, initializer_call);
        (env, contract_address, alice, bob, carol)
    };

    let employees = employee_array([(bob, 100, 1), (carol, 250, 2), (AztecAddress::zero(), 0, 0)]);
    env.call_private(alice, SalAZy::at(contract_address).issue_salaries(1, 1, employees));

    let bob_notes = env.execute_utility(SalAZy::at(contract_address).view_balance_notes(bob));
    assert_eq(bob_notes.len(), 1);
    assert_eq(bob_notes.get(0).amount, 100);

    let carol_notes = env.execute_utility(SalAZy::at(contract_address).view_balance_notes(carol));
    assert_eq(carol_notes.len(), 1);
    assert_eq(carol_notes.get(0).amount, 250);
}

#[test]
unconstrained fn salary_is_credited_without_any_claim() {
    let (env, contract_address, alice, bob) = setup();

    env.call_private(alice, SalAZy::at(contract_address).issue_salary(1, 1, bob, 100, 2));

    // Bob never sends a transaction; the salary is already his.
    let balance = env.execute_utility(SalAZy::at(contract_address).view_balance(bob));
    assert_eq(balance, 100);
}

#[test]
unconstrained fn prove_fully_paid_succeeds_when_funded_equals_issued() {
    let (env, contract_address, alice, bob) = setup();

    env.call_private(alice, SalAZy::at(contract_address).fund(1, 1, 300));
    env.call_private(alice, SalAZy::at(contract_address).issue_salary(1, 1, bob, 100, 1));
    env.call_private(alice, SalAZy::at(contract_address).issue_salary(1, 1, bob, 200, 2));

    // The ZK proof lands if planned total was funded and every salary issued.
    env.call_private(alice, SalAZy::at(contract_address).prove_fully_paid(1, 1, 300));
}

#[test(should_fail_with = "funded < planned total")]
unconstrained fn prove_fully_paid_fails_when_underfunded() {
    let (env, contract_address, alice, bob) = setup();

    env.call_private(alice, SalAZy::at(contract_address).fund(1, 1, 100));
    env.call_private(alice, SalAZy::at(contract_address).issue_salary(1, 1, bob, 100, 1));
    env.call_private(alice, SalAZy::at(contract_address).issue_salary(1, 1, bob, 100, 2));

    env.call_private(alice, SalAZy::at(contract_address).prove_fully_paid(1, 1, 200));
}

#[test(should_fail_with = "issued != planned total")]
unconstrained fn prove_fully_paid_fails_when_not_everyone_issued() {
    let (env, contract_address, alice, bob) = setup();

    env.call_private(alice, SalAZy::at(contract_address).fund(1, 1, 200));
    env.call_private(alice, SalAZy::at(contract_address).issue_salary(1, 1, bob, 100, 1));

    // Funded enough, but only 100 of the planned 200 was issued.
    env.call_private(alice, SalAZy::at(contract_address).prove_fully_paid(1, 1, 200));
}

#[test]
unconstrained fn prove_fully_paid_succeeds_with_leftover_funding() {
    let (env, contract_address, alice, bob) = setup();

    // Over-funding (500 vs planned 300) must not break the proof.
    env.call_private(alice, SalAZy::at(contract_address).fund(1, 1, 500));
    env.call_private(alice, SalAZy::at(contract_address).issue_salary(1, 1, bob, 100, 1));
    env.call_private(alice, SalAZy::at(contract_address).issue_salary(1, 1, bob, 200, 2));

    env.call_private(alice, SalAZy::at(contract_address).prove_fully_paid(1, 1, 300));
}

#[test(should_fail_with = "nothing to prove")]
unconstrained fn prove_fully_paid_fails_when_nothing_funded_or_issued() {
    let (env, contract_address, alice, bob) = setup();

    // No funding, no salaries: must NOT prove itself fully paid.
    env.call_private(alice, SalAZy::at(contract_address).prove_fully_paid(1, 1, 0));
}

#[test]
unconstrained fn business_ledgers_are_isolated() {
    let (env, contract_address, alice, bob) = setup();

    env.call_private(alice, SalAZy::at(contract_address).fund(1, 1, 100));
    env.call_private(alice, SalAZy::at(contract_address).fund(2, 1, 999));

    // Company 1 only sees company 1's funding.
    let funding_one = env.execute_utility(SalAZy::at(contract_address).view_funding(alice, 1, 1));
    assert_eq(funding_one, 100);
    let funding_two = env.execute_utility(SalAZy::at(contract_address).view_funding(alice, 2, 1));
    assert_eq(funding_two, 999);
}

#[test]
unconstrained fn salaries_accumulate_across_epochs_directly() {
    let (env, contract_address, alice, bob) = setup();

    env.call_private(alice, SalAZy::at(contract_address).issue_salary(1, 1, bob, 100, 1));
    env.call_private(alice, SalAZy::at(contract_address).issue_salary(1, 2, bob, 50, 1));

    let balance = env.execute_utility(SalAZy::at(contract_address).view_balance(bob));
    assert_eq(balance, 150);
}

// The user's real-world failure: 11 employees paid across 2 batches, with the
// period funded multiple times. Every pay run and top-up used to insert its own
// note, so the proof eventually read more than 16 note-hash read requests in a
// single call frame and crashed with "push out of bounds". Aggregation keeps
// funding and issuance at ONE note per (company, epoch) regardless of how many
// times the employer pays or tops up.
#[test]
unconstrained fn prove_fully_paid_survives_many_notes_across_repeated_funding_and_batches() {
    let (env, contract_address, alice, bob, carol, dave, erin, frank, grace, henry, iris, joe, kay) = {
        let mut env = TestEnvironment::new();
        let alice = env.create_light_account();
        let bob = env.create_light_account();
        let carol = env.create_light_account();
        let dave = env.create_light_account();
        let erin = env.create_light_account();
        let frank = env.create_light_account();
        let grace = env.create_light_account();
        let henry = env.create_light_account();
        let iris = env.create_light_account();
        let joe = env.create_light_account();
        let kay = env.create_light_account();
        let initializer_call = SalAZy::interface().constructor();
        let contract_address =
            env.deploy("@salazy_contract/SalAZy").with_private_initializer(alice, initializer_call);
        (env, contract_address, alice, bob, carol, dave, erin, frank, grace, henry, iris, joe, kay)
    };

    // Employer tops the period up 4 separate times (100 + 200 + 300 + 400 = 1000).
    env.call_private(alice, SalAZy::at(contract_address).fund(1, 4, 100));
    env.call_private(alice, SalAZy::at(contract_address).fund(1, 4, 200));
    env.call_private(alice, SalAZy::at(contract_address).fund(1, 4, 300));
    env.call_private(alice, SalAZy::at(contract_address).fund(1, 4, 400));

    // Batch 1: 8 employees (max per tx), total 600.
    let mut batch1 = employee_array([(bob, 100, 1), (carol, 100, 1), (dave, 50, 1)]);
    batch1[3] = SalAZy::Employee { address: erin, amount: 100, role: 1 };
    batch1[4] = SalAZy::Employee { address: frank, amount: 50, role: 1 };
    batch1[5] = SalAZy::Employee { address: grace, amount: 100, role: 2 };
    batch1[6] = SalAZy::Employee { address: henry, amount: 50, role: 2 };
    batch1[7] = SalAZy::Employee { address: iris, amount: 50, role: 2 };
    env.call_private(alice, SalAZy::at(contract_address).issue_salaries(1, 4, batch1));

    // Batch 2: remaining 3 employees, total 300.
    let batch2 = employee_array([(joe, 100, 1), (kay, 200, 2), (AztecAddress::zero(), 0, 0)]);
    env.call_private(alice, SalAZy::at(contract_address).issue_salaries(1, 4, batch2));

    // Planned total is 900 (600 + 300). The proof must land even though the
    // combined ledger would previously have held 15 notes.
    env.call_private(alice, SalAZy::at(contract_address).prove_fully_paid(1, 4, 900));
}
