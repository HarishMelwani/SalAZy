use aztec::protocol::address::AztecAddress;
use aztec::test::helpers::test_environment::TestEnvironment;

use salazy_contract::SalAZy;

// Minimal helper to make a padded employee array for batch issue.
fn employee_array(entries: [(AztecAddress, Field, Field); 3]) -> [SalAZy::Employee; 7] {
    let mut employees = [SalAZy::Employee { address: AztecAddress::zero(), amount: 0, role: 0 }; 7];
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

// ---------- Funding ----------

#[test]
unconstrained fn funding_is_private_to_the_employer() {
    let (env, contract_address, alice, bob) = setup();

    // First fund declares the budget: total 1000, salt 7.
    env.call_private(alice, SalAZy::at(contract_address).fund(1, 1, 1000, 1000, 7));

    let alice_funding = env.execute_utility(SalAZy::at(contract_address).view_funding(alice, 1, 1));
    assert_eq(alice_funding, 1000);

    // Bob (a third party) cannot decrypt Alice's funding note.
    let bob_view = env.execute_utility(SalAZy::at(contract_address).view_funding(bob, 1, 1));
    assert_eq(bob_view, 0);
}

#[test(should_fail)]
unconstrained fn first_fund_must_declare_a_budget() {
    let (env, contract_address, alice, _bob) = setup();
    env.call_private(alice, SalAZy::at(contract_address).fund(1, 1, 1000, 0, 0));
}

#[test]
unconstrained fn topups_inherit_the_declared_budget() {
    let (env, contract_address, alice, _bob) = setup();
    env.call_private(alice, SalAZy::at(contract_address).fund(1, 1, 300, 300, 42));
    // Top-up passes zero hints and inherits the commitment.
    env.call_private(alice, SalAZy::at(contract_address).fund(1, 1, 200, 0, 0));

    let funded = env.execute_utility(SalAZy::at(contract_address).view_funding(alice, 1, 1));
    assert_eq(funded, 500);
    // The declared budget is unchanged and readable by the owner.
    let committed =
        env.execute_utility(SalAZy::at(contract_address).view_committed_total(alice, 1, 1));
    assert_eq(committed, 300);
}

#[test(should_fail)]
unconstrained fn redeclaring_a_budget_is_rejected() {
    let (env, contract_address, alice, _bob) = setup();
    env.call_private(alice, SalAZy::at(contract_address).fund(1, 1, 300, 300, 42));
    env.call_private(alice, SalAZy::at(contract_address).fund(1, 1, 200, 999, 55));
}

// ---------- Payroll ----------

#[test]
unconstrained fn issued_salary_lands_directly_in_the_employees_balance() {
    let (env, contract_address, alice, bob) = setup();

    env.call_private(alice, SalAZy::at(contract_address).fund(1, 1, 500, 500, 11));
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

#[test(should_fail)]
unconstrained fn payroll_cannot_exceed_funding() {
    let (env, contract_address, alice, bob) = setup();
    env.call_private(alice, SalAZy::at(contract_address).fund(1, 1, 100, 100, 13));
    // 150 issued against a 100 pool must abort the whole transaction.
    env.call_private(alice, SalAZy::at(contract_address).issue_salary(1, 1, bob, 150, 1));
}

// ---------- Prove ----------

#[test]
unconstrained fn prove_succeeds_and_sets_a_public_seal() {
    let (env, contract_address, alice, bob) = setup();

    env.call_private(alice, SalAZy::at(contract_address).fund(1, 1, 500, 500, 21));
    env.call_private(alice, SalAZy::at(contract_address).issue_salary(1, 1, bob, 500, 1));

    // Before proving, the seal is unset.
    let sealed_before = env.execute_utility(SalAZy::at(contract_address).view_proved(1, 1));
    assert(!sealed_before);

    env.call_private(alice, SalAZy::at(contract_address).prove_fully_paid(1, 1));

    // PUBLIC seal: anyone can verify the period was fully paid.
    let sealed = env.execute_utility(SalAZy::at(contract_address).view_proved(1, 1));
    assert(sealed);
}

#[test(should_fail)]
unconstrained fn prove_rejects_partial_payment() {
    let (env, contract_address, alice, bob) = setup();
    env.call_private(alice, SalAZy::at(contract_address).fund(1, 1, 500, 500, 31));
    env.call_private(alice, SalAZy::at(contract_address).issue_salary(1, 1, bob, 100, 1));
    // Issued 100 of the declared 500: proving must abort.
    env.call_private(alice, SalAZy::at(contract_address).prove_fully_paid(1, 1));
}

#[test]
unconstrained fn prove_needs_no_witnesses_after_browser_loss() {
    // The commitment lives in Alice's own notes, so proving is possible even
    // if every local record was wiped: no extra arguments required.
    let (env, contract_address, alice, bob) = setup();
    env.call_private(alice, SalAZy::at(contract_address).fund(2, 3, 250, 250, 77));
    env.call_private(alice, SalAZy::at(contract_address).issue_salary(2, 3, bob, 250, 4));
    env.call_private(alice, SalAZy::at(contract_address).prove_fully_paid(2, 3));
    let sealed = env.execute_utility(SalAZy::at(contract_address).view_proved(2, 3));
    assert(sealed);
}

// ---------- Per-epoch history (v1 regression) ----------

#[test]
unconstrained fn per_epoch_ledgers_stay_scoped() {
    let (env, contract_address, alice, bob) = setup();

    // Period 1: declare, fund, pay in full.
    env.call_private(alice, SalAZy::at(contract_address).fund(7, 1, 500, 500, 101));
    env.call_private(alice, SalAZy::at(contract_address).issue_salary(7, 1, bob, 500, 1));

    // Period 2 activity must NOT absorb period 1's ledger.
    env.call_private(alice, SalAZy::at(contract_address).fund(7, 2, 400, 400, 102));
    env.call_private(alice, SalAZy::at(contract_address).issue_salary(7, 2, bob, 400, 1));

    let ep1_funded = env.execute_utility(SalAZy::at(contract_address).view_funding(alice, 7, 1));
    assert_eq(ep1_funded, 500);
    let ep1_issued = env.execute_utility(SalAZy::at(contract_address).view_issued(alice, 7, 1));
    assert_eq(ep1_issued, 500);
    let ep2_funded = env.execute_utility(SalAZy::at(contract_address).view_funding(alice, 7, 2));
    assert_eq(ep2_funded, 400);
    let ep2_issued = env.execute_utility(SalAZy::at(contract_address).view_issued(alice, 7, 2));
    assert_eq(ep2_issued, 400);

    // Both periods prove independently; seals are per-period too.
    env.call_private(alice, SalAZy::at(contract_address).prove_fully_paid(7, 1));
    env.call_private(alice, SalAZy::at(contract_address).prove_fully_paid(7, 2));
    let ep1_sealed = env.execute_utility(SalAZy::at(contract_address).view_proved(7, 1));
    assert(ep1_sealed);
    let ep2_sealed = env.execute_utility(SalAZy::at(contract_address).view_proved(7, 2));
    assert(ep2_sealed);
}

// ---------- Defund ----------

#[test]
unconstrained fn defund_pulls_back_unused_funding() {
    let (env, contract_address, alice, _bob) = setup();
    env.call_private(alice, SalAZy::at(contract_address).fund(1, 1, 500, 500, 55));
    env.call_private(alice, SalAZy::at(contract_address).defund(1, 1, 120));

    let funded = env.execute_utility(SalAZy::at(contract_address).view_funding(alice, 1, 1));
    assert_eq(funded, 380);
}

#[test(should_fail)]
unconstrained fn defund_cannot_exceed_funding() {
    let (env, contract_address, alice, _bob) = setup();
    env.call_private(alice, SalAZy::at(contract_address).fund(1, 1, 500, 500, 56));
    env.call_private(alice, SalAZy::at(contract_address).defund(1, 1, 900));
}

// ---------- Batch payrun at protocol limits ----------

#[test]
unconstrained fn batch_payrun_survives_two_batches_and_topups_then_proves() {
    let (mut env, contract_address, alice, bob) = setup();
    let carol = env.create_light_account();
    let dave = env.create_light_account();
    let erin = env.create_light_account();
    let frank = env.create_light_account();
    let grace = env.create_light_account();
    let henry = env.create_light_account();
    let iris = env.create_light_account();
    let joe = env.create_light_account();
    let kay = env.create_light_account();

    // Declared budget 900 across two top-ups.
    env.call_private(alice, SalAZy::at(contract_address).fund(1, 4, 550, 900, 64));
    env.call_private(alice, SalAZy::at(contract_address).fund(1, 4, 350, 0, 0));

    // Batch 1: 7 employees (max per tx), total 550.
    let mut batch1 = employee_array([(bob, 100, 1), (carol, 100, 1), (dave, 50, 1)]);
    batch1[3] = SalAZy::Employee { address: erin, amount: 100, role: 1 };
    batch1[4] = SalAZy::Employee { address: frank, amount: 50, role: 1 };
    batch1[5] = SalAZy::Employee { address: grace, amount: 100, role: 2 };
    batch1[6] = SalAZy::Employee { address: henry, amount: 50, role: 2 };
    env.call_private(alice, SalAZy::at(contract_address).issue_salaries(1, 4, batch1));

    // Batch 2: remaining 4 employees, total 350.
    let mut batch2 = employee_array([(iris, 50, 2), (joe, 100, 1), (kay, 200, 2)]);
    batch2[3] = SalAZy::Employee { address: AztecAddress::zero(), amount: 0, role: 0 };
    env.call_private(alice, SalAZy::at(contract_address).issue_salaries(1, 4, batch2));

    // Issued exactly the declared 900: the proof lands and seals publicly.
    env.call_private(alice, SalAZy::at(contract_address).prove_fully_paid(1, 4));
    let sealed = env.execute_utility(SalAZy::at(contract_address).view_proved(1, 4));
    assert(sealed);
}
