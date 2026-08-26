/// SalAZy v2 - fully private payroll on Aztec, verifiable on-chain.
///
/// Employers run payroll without revealing who was paid how much. Every
/// salary is a private note encrypted to the employee's keypair; the employer's
/// funding and issuance ledgers are private notes too.
///
/// v2 makes the whole lifecycle checkable ON CHAIN, with zero trusted local
/// records:
///  1. DECLARED BUDGET - the first fund of a period locks a private commitment
///     (poseidon2_hash([total, salt])) plus the plaintext-for-owner total inside a
///     CommitNote. Later top-ups inherit it, so the payroll size is declared
///     before any salary is paid.
///  2. ENFORCED CAP - the contract itself rejects any payrun that would push
///     the period's cumulative issued above its funded pool. Over-payment is
///     impossible, not just discouraged.
///  3. ARGLESS PROOF - prove_fully_paid(company, epoch) reads the commitment
///     straight from the employer's own notes (no witnesses, works from a
///     freshly restored browser), asserts funded >= committed && issued ==
///     committed, and publicly marks the period proved.
///  4. PUBLIC SEAL - proved periods are recorded in a PUBLIC map, so anyone
///     (an auditor, an investor) can verify "company C fully paid period E"
///     while amounts stay hidden forever.
///
/// Per-period ledgers are scoped by key = poseidon2_hash([company, epoch]) using a
/// SINGLE filter select, which fixes v1's cross-epoch note merging: finished
/// periods keep their own totals readable.
///
/// Employees receive salaries directly in their private balance ledger via
/// non-interactive handshakes anchored in the canonical HandshakeRegistry -
/// no registration, nothing to claim.
#[aztec::macros::aztec]
pub contract SalAZy {
    use aztec::{
        macros::{functions::{external, initializer, internal}, notes::note, storage::storage},
        messages::delivery::MessageDelivery,
        protocol::{
            address::AztecAddress,
            hash::poseidon2_hash,
            traits::{Deserialize, Packable, Serialize},
        },
        state_vars::{Map, Owned, PrivateSet, PublicMutable},
    };
    use aztec::note::{
        constants::MAX_NOTES_PER_PAGE,
        note_getter_options::NoteGetterOptions,
        note_interface::NoteProperties,
        note_viewer_options::NoteViewerOptions,
    };
    use aztec::protocol::constants::MAX_NOTE_HASH_READ_REQUESTS_PER_CALL;
    use aztec::utils::comparison::{Comparator, compare};

    /// Maximum number of employees paid in a single private transaction. Bound
    /// by MAX_PRIVATE_CALL_STACK_LENGTH_PER_CALL (8): the issue_salaries frame
    /// counts as one private call, and each salary to a fresh recipient triggers
    /// a nested non-interactive handshake call to the HandshakeRegistry. So the
    /// safe batch is 7 employees when every recipient is new. (Note-hash and
    /// private-log budgets also cap at 16, but the call-stack limit binds first.)
    global MAX_EMPLOYEES_PER_PAYRUN: u32 = 7;

    /// Balance views page over the employee's salary notes so a long work history
    /// (many pay runs) never truncates the total. `MAX_BALANCE_PAGES` pages of
    /// `MAX_NOTES_PER_PAGE` notes each.
    global MAX_BALANCE_PAGES: u32 = 10;
    global MAX_BALANCE_NOTES: u32 = MAX_BALANCE_PAGES * MAX_NOTES_PER_PAGE;

    /// A single salary instruction used by the batch `issue_salaries` function.
    #[derive(Deserialize, Serialize)]
    pub struct Employee {
        pub address: AztecAddress,
        pub amount: Field,
        pub role: Field,
    }

    /// The employer's private deposit for one business, for one pay period.
    /// `commit` binds the period to the declared payroll budget:
    /// commit = poseidon2_hash([total, salt]), set by the FIRST fund of the period.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    #[note]
    pub struct FundingNote {
        pub key: Field,
        pub company: Field,
        pub epoch: Field,
        pub amount: Field,
        pub commit: Field,
    }

    /// The employer's private record of salaries issued in one period.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    #[note]
    pub struct IssuanceNote {
        pub key: Field,
        pub company: Field,
        pub epoch: Field,
        pub amount: Field,
    }

    /// The period's declared budget: total and salt whose poseidon commitment
    /// is mirrored inside the funding note. Lives in the employer's private
    /// ledger, so the witnesses for `prove_fully_paid` are chain-stored and
    /// survive any browser loss.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    #[note]
    pub struct CommitNote {
        pub key: Field,
        pub company: Field,
        pub epoch: Field,
        pub total: Field,
        pub salt: Field,
    }

    /// A salary, encrypted to the employee it belongs to. Inserted directly into
    /// the employee's balance ledger the moment payroll runs - no claim needed.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    #[note]
    pub struct SalaryNote {
        pub company: Field,
        pub epoch: Field,
        pub amount: Field,
        pub role: Field,
    }

    #[storage]
    struct Storage<Context> {
        funding: Owned<PrivateSet<FundingNote, Context>, Context>,
        issued: Owned<PrivateSet<IssuanceNote, Context>, Context>,
        balances: Owned<PrivateSet<SalaryNote, Context>, Context>,
        commits: Owned<PrivateSet<CommitNote, Context>, Context>,
        /// PUBLIC seal: proved[poseidon2_hash([company, epoch])] = true. Anyone can
        /// read it; it reveals only THAT a period was proved fully paid,
        /// never any amount.
        proved: Map<Field, PublicMutable<bool, Context>, Context>,
    }

    #[external("private")]
    #[initializer]
    fn constructor() {}

    /// Funds a pay period. The deposit is a private note in the employer's own
    /// ledger; no one can see the amount. Funding is aggregated into a single
    /// note per period key. On the FIRST fund of a period, `total_hint` and
    /// `salt_hint` create the period's CommitNote (declared budget =
    /// poseidon2_hash([total_hint, salt_hint]), mirrored into the funding note).
    /// Later top-ups MUST pass total_hint == 0 and inherit the existing
    /// commitment. This makes the budget declared before any salary is paid.
    #[external("private")]
    fn fund(
        company: Field,
        epoch: Field,
        amount: Field,
        total_hint: Field,
        salt_hint: Field,
    ) {
        let employer = self.msg_sender();
        let key = poseidon2_hash([company, epoch]);

        let mut commit = 0;
        let props_c = CommitNote::properties();
        let mut opts_c = NoteGetterOptions::<CommitNote, <CommitNote as Packable>::N, Field, Field>::new();
        opts_c = opts_c.select(props_c.key, Comparator.EQ, key);
        let commits = self.storage.commits.at(employer).get_notes(opts_c);
        for i in 0..MAX_NOTE_HASH_READ_REQUESTS_PER_CALL {
            if i < commits.len() {
                let c = commits.get_unchecked(i).note;
                if c.key == key {
                    commit = poseidon2_hash([c.total, c.salt]);
                }
            }
        }

        if commit == 0 {
            // First fund of the period: declare the budget.
            assert(total_hint != 0, "SalAZy: first fund must declare the payroll total");
            assert(salt_hint != 0, "SalAZy: salt required");
            let note_c = CommitNote {
                key,
                company,
                epoch,
                total: total_hint,
                salt: salt_hint,
            };
            self.storage.commits.at(employer).insert(note_c).deliver(MessageDelivery::onchain_unconstrained());
            commit = poseidon2_hash([total_hint, salt_hint]);
        } else {
            // Top-up: the budget is already declared and immutable.
            assert(total_hint == 0, "SalAZy: budget already declared");
        }

        let props = FundingNote::properties();
        let mut options = NoteGetterOptions::<FundingNote, <FundingNote as Packable>::N, Field, Field>::new();
        options = options.select(props.key, Comparator.EQ, key);
        let existing = self.storage.funding.at(employer).pop_notes(options);
        let mut total = amount;
        for i in 0..MAX_NOTE_HASH_READ_REQUESTS_PER_CALL {
            if i < existing.len() {
                total += existing.get_unchecked(i).amount;
            }
        }
        let note = FundingNote { key, company, epoch, amount: total, commit };
        self.storage.funding.at(employer).insert(note).deliver(MessageDelivery::onchain_unconstrained());
    }

    /// Pulls back up to `amount` of unused funding from a period. Useful when
    /// the period was over-funded; the committed budget is unchanged, so a
    /// period funded below its declared total simply cannot prove.
    #[external("private")]
    fn defund(company: Field, epoch: Field, amount: Field) {
        let employer = self.msg_sender();
        let key = poseidon2_hash([company, epoch]);
        let props = FundingNote::properties();
        let mut options = NoteGetterOptions::<FundingNote, <FundingNote as Packable>::N, Field, Field>::new();
        options = options.select(props.key, Comparator.EQ, key);
        let existing = self.storage.funding.at(employer).pop_notes(options);
        let mut remaining = 0;
        let mut commit = 0;
        for i in 0..MAX_NOTE_HASH_READ_REQUESTS_PER_CALL {
            if i < existing.len() {
                let n = existing.get_unchecked(i);
                remaining += n.amount;
                commit = n.commit;
            }
        }
        assert(compare(remaining, Comparator.GTE, amount), "SalAZy: defund exceeds funding");
        assert(remaining - amount != 0, "SalAZy: cannot empty a funded period");
        let note = FundingNote { key, company, epoch, amount: remaining - amount, commit };
        self.storage.funding.at(employer).insert(note).deliver(MessageDelivery::onchain_unconstrained());
    }

    /// Issues a single salary: credited directly to the employee's private
    /// balance, plus a matching entry in the employer's private issuance ledger.
    #[external("private")]
    fn issue_salary(company: Field, epoch: Field, employee: AztecAddress, amount: Field, role: Field) {
        self.internal.insert_balance(company, epoch, employee, amount, role);
        self.internal.add_issuance(company, epoch, amount);
    }

    /// Pays every employee in one private transaction. Zero-address slots are
    /// skipped, so the array can be padded from the frontend.
    #[external("private")]
    fn issue_salaries(company: Field, epoch: Field, employees: [Employee; MAX_EMPLOYEES_PER_PAYRUN]) {
        let mut batch_total = 0 as Field;
        for i in 0..MAX_EMPLOYEES_PER_PAYRUN {
            let employee = employees[i];
            if !employee.address.is_zero() {
                self.internal.insert_balance(company, epoch, employee.address, employee.amount, employee.role);
                batch_total += employee.amount;
            }
        }
        if batch_total != 0 {
            self.internal.add_issuance(company, epoch, batch_total);
        }
    }

    /// ZERO-KNOWLEDGE PROOF that the period was fully paid, checked entirely
    /// against the employer's own chain-stored notes (works from a fresh
    /// browser - no witnesses, no local records):
    ///  - the period has a declared budget (CommitNote exists),
    ///  - the funding note carries exactly that budget's commitment,
    ///  - funding covers the declared total,
    ///  - issued == declared total (everyone was paid exactly the budget),
    /// then the period is marked PROVED in a PUBLIC map anyone can verify.
    #[external("private")]
    fn prove_fully_paid(company: Field, epoch: Field) {
        let employer = self.msg_sender();
        let key = poseidon2_hash([company, epoch]);

        // The declared budget, from the employer's own private notes.
        let props_c = CommitNote::properties();
        let mut opts_c = NoteGetterOptions::<CommitNote, <CommitNote as Packable>::N, Field, Field>::new();
        opts_c = opts_c.select(props_c.key, Comparator.EQ, key);
        let commits = self.storage.commits.at(employer).get_notes(opts_c);
        let mut total = 0;
        let mut salt = 0;
        for i in 0..MAX_NOTE_HASH_READ_REQUESTS_PER_CALL {
            if i < commits.len() {
                let c = commits.get_unchecked(i).note;
                if c.key == key {
                    total = c.total;
                    salt = c.salt;
                }
            }
        }
        assert(total != 0, "SalAZy: undeclared period");

        // Funding must exist and carry the declared budget's commitment.
        let props_f = FundingNote::properties();
        let mut opts_f = NoteGetterOptions::<FundingNote, <FundingNote as Packable>::N, Field, Field>::new();
        opts_f = opts_f.select(props_f.key, Comparator.EQ, key);
        let funding_notes = self.storage.funding.at(employer).get_notes(opts_f);
        let mut funded = 0;
        for i in 0..MAX_NOTE_HASH_READ_REQUESTS_PER_CALL {
            if i < funding_notes.len() {
                let n = funding_notes.get_unchecked(i).note;
                if n.key == key {
                    assert(n.commit == poseidon2_hash([total, salt]), "SalAZy: funding commit mismatch");
                    funded += n.amount;
                }
            }
        }
        assert(compare(funded, Comparator.GTE, total), "SalAZy: funded < declared payroll");

        // Issued must EQUAL the declared total: everyone paid, no more, less.
        let props_i = IssuanceNote::properties();
        let mut opts_i = NoteGetterOptions::<IssuanceNote, <IssuanceNote as Packable>::N, Field, Field>::new();
        opts_i = opts_i.select(props_i.key, Comparator.EQ, key);
        let issued_notes = self.storage.issued.at(employer).get_notes(opts_i);
        let mut issued = 0;
        for i in 0..MAX_NOTE_HASH_READ_REQUESTS_PER_CALL {
            if i < issued_notes.len() {
                let n = issued_notes.get_unchecked(i).note;
                if n.key == key {
                    issued += n.amount;
                }
            }
        }
        assert(issued == total, "SalAZy: issued != declared payroll");

        // PUBLIC seal, visible to anyone forever.
        self.enqueue_self.mark_proved(company, epoch);
    }

    /// Public seal write, enqueued by prove_fully_paid. Reveals only THAT the
    /// (pseudonymous company, period) pair was proved fully paid.
    #[external("public")]
    fn mark_proved(company: Field, epoch: Field) {
        let key = poseidon2_hash([company, epoch]);
        self.storage.proved.at(key).write(true);
    }

    /// Sums the employer's private funding notes for a business and pay period.
    #[internal("private")]
    fn sum_funding(company: Field, epoch: Field) -> Field {
        let employer = self.msg_sender();
        let key = poseidon2_hash([company, epoch]);
        let props = FundingNote::properties();
        let mut options = NoteGetterOptions::<FundingNote, <FundingNote as Packable>::N, Field, Field>::new();
        options = options.select(props.key, Comparator.EQ, key);
        let notes = self.storage.funding.at(employer).get_notes(options);
        let mut total = 0 as Field;
        for i in 0..MAX_NOTE_HASH_READ_REQUESTS_PER_CALL {
            if i < notes.len() {
                let note = notes.get_unchecked(i).note;
                if note.key == key {
                    total += note.amount;
                }
            }
        }
        total
    }

    /// Aggregates the employer's issuance ledger for the period and ENFORCES
    /// the declared funding cap on-chain: cumulative issued may never exceed
    /// the funded pool. Over-payment aborts the whole payrun.
    #[internal("private")]
    fn add_issuance(company: Field, epoch: Field, amount: Field) {
        let employer = self.msg_sender();
        let key = poseidon2_hash([company, epoch]);

        let props_f = FundingNote::properties();
        let mut opts_f = NoteGetterOptions::<FundingNote, <FundingNote as Packable>::N, Field, Field>::new();
        opts_f = opts_f.select(props_f.key, Comparator.EQ, key);
        let funding_notes = self.storage.funding.at(employer).get_notes(opts_f);
        let mut funded = 0 as Field;
        for i in 0..MAX_NOTE_HASH_READ_REQUESTS_PER_CALL {
            if i < funding_notes.len() {
                let n = funding_notes.get_unchecked(i).note;
                if n.key == key {
                    funded += n.amount;
                }
            }
        }

        let props = IssuanceNote::properties();
        let mut options = NoteGetterOptions::<IssuanceNote, <IssuanceNote as Packable>::N, Field, Field>::new();
        options = options.select(props.key, Comparator.EQ, key);
        let existing = self.storage.issued.at(employer).pop_notes(options);
        let mut total = amount;
        for i in 0..MAX_NOTE_HASH_READ_REQUESTS_PER_CALL {
            if i < existing.len() {
                total += existing.get_unchecked(i).amount;
            }
        }
        assert(compare(total, Comparator.LTE, funded), "SalAZy: payroll exceeds funding");

        let issuance = IssuanceNote { key, company, epoch, amount: total };
        self.storage.issued.at(employer).insert(issuance).deliver(MessageDelivery::onchain_unconstrained());
    }

    /// Credits a salary directly into an employee's balance, encrypted to them
    /// and discovered via a non-interactive handshake (no prior registration or
    /// claim needed).
    #[internal("private")]
    fn insert_balance(company: Field, epoch: Field, employee: AztecAddress, amount: Field, role: Field) {
        let note = SalaryNote { company, epoch, amount, role };
        self.storage.balances.at(employee).insert(note).deliver(
            MessageDelivery::onchain_unconstrained().via_non_interactive_handshake(),
        );
    }

    /// Employer's total funding for one business and pay period (private view).
    #[external("utility")]
    unconstrained fn view_funding(owner: AztecAddress, company: Field, epoch: Field) -> Field {
        let key = poseidon2_hash([company, epoch]);
        let props = FundingNote::properties();
        let mut options = NoteViewerOptions::<FundingNote, <FundingNote as Packable>::N>::new();
        options = options.select(props.key, Comparator.EQ, key);
        let notes = self.storage.funding.at(owner).view_notes(options);
        let mut total = 0 as Field;
        for i in 0..MAX_NOTES_PER_PAGE {
            if i < notes.len() {
                let note = notes.get_unchecked(i);
                if note.key == key {
                    total += note.amount;
                }
            }
        }
        total
    }

    /// Employer's declared payroll budget for one period (private view).
    /// Returns 0 when the period was never funded/declared. Only readable by
    /// the employer's own wallet - it comes from their decrypted notes.
    #[external("utility")]
    unconstrained fn view_committed_total(owner: AztecAddress, company: Field, epoch: Field) -> Field {
        let key = poseidon2_hash([company, epoch]);
        let props = CommitNote::properties();
        let mut options = NoteViewerOptions::<CommitNote, <CommitNote as Packable>::N>::new();
        options = options.select(props.key, Comparator.EQ, key);
        let notes = self.storage.commits.at(owner).view_notes(options);
        let mut total = 0 as Field;
        for i in 0..MAX_NOTES_PER_PAGE {
            if i < notes.len() {
                let note = notes.get_unchecked(i);
                if note.key == key {
                    total = note.total;
                }
            }
        }
        total
    }

    /// Employer's total issued for one business and pay period (private view).
    #[external("utility")]
    unconstrained fn view_issued(owner: AztecAddress, company: Field, epoch: Field) -> Field {
        let key = poseidon2_hash([company, epoch]);
        let props = IssuanceNote::properties();
        let mut options = NoteViewerOptions::<IssuanceNote, <IssuanceNote as Packable>::N>::new();
        options = options.select(props.key, Comparator.EQ, key);
        let notes = self.storage.issued.at(owner).view_notes(options);
        let mut total = 0 as Field;
        for i in 0..MAX_NOTES_PER_PAGE {
            if i < notes.len() {
                let note = notes.get_unchecked(i);
                if note.key == key {
                    total += note.amount;
                }
            }
        }
        total
    }

    /// Whether issued == committed total and funding covers it, for one period
    /// (private view). Mirrors the prove checks for the employer's dashboard.
    #[external("utility")]
    unconstrained fn is_fully_paid(owner: AztecAddress, company: Field, epoch: Field) -> bool {
        let key = poseidon2_hash([company, epoch]);

        let props_c = CommitNote::properties();
        let mut opts_c = NoteViewerOptions::<CommitNote, <CommitNote as Packable>::N>::new();
        opts_c = opts_c.select(props_c.key, Comparator.EQ, key);
        let commits = self.storage.commits.at(owner).view_notes(opts_c);
        let mut total = 0 as Field;
        for i in 0..MAX_NOTES_PER_PAGE {
            if i < commits.len() {
                let note = commits.get_unchecked(i);
                if note.key == key {
                    total = note.total;
                }
            }
        }

        let props_f = FundingNote::properties();
        let mut opts_f = NoteViewerOptions::<FundingNote, <FundingNote as Packable>::N>::new();
        opts_f = opts_f.select(props_f.key, Comparator.EQ, key);
        let funding_notes = self.storage.funding.at(owner).view_notes(opts_f);
        let mut funded = 0 as Field;
        for i in 0..MAX_NOTES_PER_PAGE {
            if i < funding_notes.len() {
                let note = funding_notes.get_unchecked(i);
                if note.key == key {
                    funded += note.amount;
                }
            }
        }

        let props_i = IssuanceNote::properties();
        let mut opts_i = NoteViewerOptions::<IssuanceNote, <IssuanceNote as Packable>::N>::new();
        opts_i = opts_i.select(props_i.key, Comparator.EQ, key);
        let issued_notes = self.storage.issued.at(owner).view_notes(opts_i);
        let mut issued = 0 as Field;
        for i in 0..MAX_NOTES_PER_PAGE {
            if i < issued_notes.len() {
                let note = issued_notes.get_unchecked(i);
                if note.key == key {
                    issued += note.amount;
                }
            }
        }
        (compare(funded, Comparator.GTE, total)) & (issued == total) & (total != 0)
    }

    /// PUBLIC read of the proved seal for one period. Anyone may call this -
    /// it is how auditors verify a company paid its payroll without learning
    /// anything about amounts.
    #[external("utility")]
    unconstrained fn view_proved(company: Field, epoch: Field) -> bool {
        let key = poseidon2_hash([company, epoch]);
        self.storage.proved.at(key).read()
    }

    /// Employee's received salary notes across all pay periods (private view).
    #[external("utility")]
    unconstrained fn view_balance_notes(owner: AztecAddress) -> BoundedVec<SalaryNote, MAX_BALANCE_NOTES> {
        let mut all = BoundedVec::new();
        let mut offset = 0 as u32;
        for page in 0..MAX_BALANCE_PAGES {
            let mut options = NoteViewerOptions::<SalaryNote, <SalaryNote as Packable>::N>::new();
            options.set_offset(offset);
            let notes = self.storage.balances.at(owner).view_notes(options);
            for i in 0..MAX_NOTES_PER_PAGE {
                if i < notes.len() {
                    all.push(notes.get_unchecked(i));
                }
            }
            if notes.len() < MAX_NOTES_PER_PAGE {
                break;
            }
            offset += MAX_NOTES_PER_PAGE as u32;
        }
        all
    }

    /// Employee's balance (sum across all pay periods). Paginates so no pay run
    /// is ever missed after the first 10.
    #[external("utility")]
    unconstrained fn view_balance(owner: AztecAddress) -> Field {
        let mut total = 0 as Field;
        let mut offset = 0 as u32;
        for page in 0..MAX_BALANCE_PAGES {
            let mut options = NoteViewerOptions::<SalaryNote, <SalaryNote as Packable>::N>::new();
            options.set_offset(offset);
            let notes = self.storage.balances.at(owner).view_notes(options);
            for i in 0..MAX_NOTES_PER_PAGE {
                if i < notes.len() {
                    total += notes.get_unchecked(i).amount;
                }
            }
            if notes.len() < MAX_NOTES_PER_PAGE {
                break;
            }
            offset += MAX_NOTES_PER_PAGE as u32;
        }
        total
    }
}
