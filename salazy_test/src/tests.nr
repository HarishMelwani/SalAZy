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
unconstrained fn issued_salary_lands_in_the_employees_inbox() {
    let (env, contract_address, alice, bob) = setup();

    env.call_private(alice, SalAZy::at(contract_address).issue_salary(1, 1, bob, 100, 2));

    let paychecks = env.execute_utility(SalAZy::at(contract_address).view_paychecks(bob));
    assert_eq(paychecks.len(), 1);
    assert_eq(paychecks.get(0).company, 1);
    assert_eq(paychecks.get(0).epoch, 1);
    assert_eq(paychecks.get(0).amount, 100);
    assert_eq(paychecks.get(0).role, 2);
}

#[test]
unconstrained fn employer_cannot_read_the_employees_paycheck() {
    let (env, contract_address, alice, bob) = setup();

    env.call_private(alice, SalAZy::at(contract_address).issue_salary(1, 1, bob, 100, 2));

    // Alice cannot decrypt Bob's paycheck, even though she created it.
    let alice_paychecks = env.execute_utility(SalAZy::at(contract_address).view_paychecks(alice));
    assert_eq(alice_paychecks.len(), 0);
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

    let bob_paychecks = env.execute_utility(SalAZy::at(contract_address).view_paychecks(bob));
    assert_eq(bob_paychecks.len(), 1);
    assert_eq(bob_paychecks.get(0).amount, 100);

    let carol_paychecks = env.execute_utility(SalAZy::at(contract_address).view_paychecks(carol));
    assert_eq(carol_paychecks.len(), 1);
    assert_eq(carol_paychecks.get(0).amount, 250);
}

#[test]
unconstrained fn employee_can_claim_into_their_private_balance() {
    let (env, contract_address, alice, bob) = setup();

    env.call_private(alice, SalAZy::at(contract_address).issue_salary(1, 1, bob, 100, 2));
    env.call_private(bob, SalAZy::at(contract_address).claim_salary(1));

    let balance = env.execute_utility(SalAZy::at(contract_address).view_balance(bob));
    assert_eq(balance, 100);

    // The paycheck was spent; the inbox is now empty.
    let paychecks = env.execute_utility(SalAZy::at(contract_address).view_paychecks(bob));
    assert_eq(paychecks.len(), 0);
}

#[test]
unconstrained fn prove_fully_paid_succeeds_when_funded_equals_issued() {
    let (env, contract_address, alice, bob) = setup();

    env.call_private(alice, SalAZy::at(contract_address).fund(1, 1, 300));
    env.call_private(alice, SalAZy::at(contract_address).issue_salary(1, 1, bob, 100, 1));
    env.call_private(alice, SalAZy::at(contract_address).issue_salary(1, 1, bob, 200, 2));

    // The ZK proof lands only if issued == funded, revealing no amounts.
    env.call_private(alice, SalAZy::at(contract_address).prove_fully_paid(1, 1));
}

#[test(should_fail_with = "issued != funded")]
unconstrained fn prove_fully_paid_fails_when_underfunded() {
    let (env, contract_address, alice, bob) = setup();

    env.call_private(alice, SalAZy::at(contract_address).fund(1, 1, 100));
    env.call_private(alice, SalAZy::at(contract_address).issue_salary(1, 1, bob, 100, 1));
    env.call_private(alice, SalAZy::at(contract_address).issue_salary(1, 1, bob, 100, 2));

    env.call_private(alice, SalAZy::at(contract_address).prove_fully_paid(1, 1));
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
unconstrained fn claiming_accumulates_across_epochs() {
    let (env, contract_address, alice, bob) = setup();

    env.call_private(alice, SalAZy::at(contract_address).issue_salary(1, 1, bob, 100, 1));
    env.call_private(alice, SalAZy::at(contract_address).issue_salary(1, 2, bob, 50, 1));
    env.call_private(bob, SalAZy::at(contract_address).claim_salary(1));
    env.call_private(bob, SalAZy::at(contract_address).claim_salary(2));

    let balance = env.execute_utility(SalAZy::at(contract_address).view_balance(bob));
    assert_eq(balance, 150);
}
