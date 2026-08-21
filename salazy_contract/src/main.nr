/// SalAZy - fully private payroll on Aztec.
///
/// Employers run payroll without revealing who was paid how much, or even the
/// total they deposited. Every salary is a private note encrypted to the
/// employee's keypair; the employer's funding and issuance ledgers are private
/// notes too. A zero-knowledge `prove_fully_paid` asserts that what was issued
/// equals what was funded for a pay period - revealing zero individual amounts.
///
/// Employees receive their salary directly in their private balance ledger via
/// non-interactive handshakes anchored in the canonical HandshakeRegistry, so
/// they need no prior registration - and nothing to claim.
#[aztec::macros::aztec]
pub contract SalAZy {
    use aztec::{
        macros::{functions::{external, initializer, internal}, notes::note, storage::storage},
        messages::delivery::MessageDelivery,
        protocol::{
            address::AztecAddress,
            traits::{Deserialize, Packable, Serialize},
        },
        state_vars::{Owned, PrivateSet},
    };
    use aztec::note::{
        constants::MAX_NOTES_PER_PAGE,
        note_getter_options::NoteGetterOptions,
        note_interface::NoteProperties,
        note_viewer_options::NoteViewerOptions,
    };
    use aztec::protocol::constants::MAX_NOTE_HASH_READ_REQUESTS_PER_CALL;
    use aztec::utils::comparison::{Comparator, compare};

    /// Maximum number of employees paid in a single private transaction. The
    /// hard protocol limit is MAX_NOTE_HASHES_PER_CALL (16) note hashes per call
    /// frame: each employee's SalaryNote is one note hash, and the aggregated
    /// issuance note adds one more — all in the same frame because internal
    /// calls are inlined. So N + 1 <= 16 gives 15.
    global MAX_EMPLOYEES_PER_PAYRUN: u32 = 15;

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
    #[derive(Deserialize, Eq, Packable, Serialize)]
    #[note]
    pub struct FundingNote {
        pub company: Field,
        pub epoch: Field,
        pub amount: Field,
    }

    /// The employer's private record of a single salary it issued.
    #[derive(Deserialize, Eq, Packable, Serialize)]
    #[note]
    pub struct IssuanceNote {
        pub company: Field,
        pub epoch: Field,
        pub amount: Field,
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
    }

    #[external("private")]
    #[initializer]
    fn constructor() {}

    /// Funds a pay period. The deposit is a private note in the employer's own
    /// ledger; no one can see the amount. Funding is aggregated into a single
    /// note per (company, epoch): each call nullifies any prior funding for the
    /// period and re-inserts one combined note. This keeps the note count read
    /// by `prove_fully_paid` tiny regardless of how many times the employer tops
    /// up the period.
    #[external("private")]
    fn fund(company: Field, epoch: Field, amount: Field) {
        let employer = self.msg_sender();
        let props = FundingNote::properties();
        let mut options = NoteGetterOptions::<FundingNote, <FundingNote as Packable>::N, Field, Field>::new();
        options.select(props.company, Comparator.EQ, company).select(props.epoch, Comparator.EQ, epoch);
        let existing = self.storage.funding.at(employer).pop_notes(options);
        let mut total = amount;
        for i in 0..MAX_NOTE_HASH_READ_REQUESTS_PER_CALL {
            if i < existing.len() {
                total += existing.get_unchecked(i).amount;
            }
        }
        let note = FundingNote { company, epoch, amount: total };
        self.storage.funding.at(employer).insert(note).deliver(MessageDelivery::onchain_unconstrained());
    }

    /// Issues a single salary: credited directly to the employee's private
    /// balance, plus a matching entry in the employer's private issuance ledger.
    /// Issuance is aggregated into one note per (company, epoch), same as
    /// funding, so the proof never has to read more than a couple of notes.
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

    /// ZERO-KNOWLEDGE PROOF: asserts that the employer planned to pay `total`
    /// this period, funded at least that, and issued exactly that. All three are
    /// private inputs/ledgers, so no individual amount is ever revealed - the
    /// transaction landing IS the proof. Requires a non-zero total, so an empty
    /// or unpaid period can never "prove" itself fully paid. Over-funding is
    /// allowed: leftover funding simply stays in the ledger for future periods.
    #[external("private")]
    fn prove_fully_paid(company: Field, epoch: Field, total: Field) {
        assert(total != 0, "SalAZy: nothing to prove");
        let funded = self.internal.sum_funding(company, epoch);
        let issued = self.internal.sum_issued(company, epoch);
        assert(compare(funded, Comparator.GTE, total), "SalAZy: funded < planned total");
        assert(issued == total, "SalAZy: issued != planned total");
    }

    /// Sums the employer's private funding notes for a business and pay period.
    #[internal("private")]
    fn sum_funding(company: Field, epoch: Field) -> Field {
        let employer = self.msg_sender();
        let props = FundingNote::properties();
        let mut options = NoteGetterOptions::<FundingNote, <FundingNote as Packable>::N, Field, Field>::new();
        options.select(props.company, Comparator.EQ, company).select(props.epoch, Comparator.EQ, epoch);
        let notes = self.storage.funding.at(employer).get_notes(options);
        let mut total = 0 as Field;
        for i in 0..MAX_NOTE_HASH_READ_REQUESTS_PER_CALL {
            if i < notes.len() {
                let note = notes.get_unchecked(i).note;
                if (note.company == company) & (note.epoch == epoch) {
                    total += note.amount;
                }
            }
        }
        total
    }

    /// Sums the employer's private issuance notes for a business and pay period.
    #[internal("private")]
    fn sum_issued(company: Field, epoch: Field) -> Field {
        let employer = self.msg_sender();
        let props = IssuanceNote::properties();
        let mut options = NoteGetterOptions::<IssuanceNote, <IssuanceNote as Packable>::N, Field, Field>::new();
        options.select(props.company, Comparator.EQ, company).select(props.epoch, Comparator.EQ, epoch);
        let notes = self.storage.issued.at(employer).get_notes(options);
        let mut total = 0 as Field;
        for i in 0..MAX_NOTE_HASH_READ_REQUESTS_PER_CALL {
            if i < notes.len() {
                let note = notes.get_unchecked(i).note;
                if (note.company == company) & (note.epoch == epoch) {
                    total += note.amount;
                }
            }
        }
        total
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

    /// Aggregates the employer's issuance ledger: nullifies any prior issuance
    /// note for the (company, epoch) and re-inserts a single note holding the
    /// running total. Keeps the per-period issuance at one note, so the ZK proof
    /// never has to read more than a handful of notes.
    #[internal("private")]
    fn add_issuance(company: Field, epoch: Field, amount: Field) {
        let employer = self.msg_sender();
        let props = IssuanceNote::properties();
        let mut options = NoteGetterOptions::<IssuanceNote, <IssuanceNote as Packable>::N, Field, Field>::new();
        options.select(props.company, Comparator.EQ, company).select(props.epoch, Comparator.EQ, epoch);
        let existing = self.storage.issued.at(employer).pop_notes(options);
        let mut total = amount;
        for i in 0..MAX_NOTE_HASH_READ_REQUESTS_PER_CALL {
            if i < existing.len() {
                total += existing.get_unchecked(i).amount;
            }
        }
        let issuance = IssuanceNote { company, epoch, amount: total };
        self.storage.issued.at(employer).insert(issuance).deliver(MessageDelivery::onchain_unconstrained());
    }

    /// Employer's total funding for one business and pay period (private view).
    #[external("utility")]
    unconstrained fn view_funding(owner: AztecAddress, company: Field, epoch: Field) -> Field {
        let props = FundingNote::properties();
        let mut options = NoteViewerOptions::<FundingNote, <FundingNote as Packable>::N>::new();
        options.select(props.company, Comparator.EQ, company).select(props.epoch, Comparator.EQ, epoch);
        let notes = self.storage.funding.at(owner).view_notes(options);
        let mut total = 0 as Field;
        for i in 0..MAX_NOTES_PER_PAGE {
            if i < notes.len() {
                let note = notes.get_unchecked(i);
                if (note.company == company) & (note.epoch == epoch) {
                    total += note.amount;
                }
            }
        }
        total
    }

    /// Employer's total issued for one business and pay period (private view).
    #[external("utility")]
    unconstrained fn view_issued(owner: AztecAddress, company: Field, epoch: Field) -> Field {
        let props = IssuanceNote::properties();
        let mut options = NoteViewerOptions::<IssuanceNote, <IssuanceNote as Packable>::N>::new();
        options.select(props.company, Comparator.EQ, company).select(props.epoch, Comparator.EQ, epoch);
        let notes = self.storage.issued.at(owner).view_notes(options);
        let mut total = 0 as Field;
        for i in 0..MAX_NOTES_PER_PAGE {
            if i < notes.len() {
                let note = notes.get_unchecked(i);
                if (note.company == company) & (note.epoch == epoch) {
                    total += note.amount;
                }
            }
        }
        total
    }

    /// Whether issued == funded for a business and pay period (private view).
    #[external("utility")]
    unconstrained fn is_fully_paid(owner: AztecAddress, company: Field, epoch: Field) -> pub bool {
        let funding_props = FundingNote::properties();
        let mut funding_options = NoteViewerOptions::<FundingNote, <FundingNote as Packable>::N>::new();
        funding_options.select(funding_props.company, Comparator.EQ, company)
            .select(funding_props.epoch, Comparator.EQ, epoch);
        let funding_notes = self.storage.funding.at(owner).view_notes(funding_options);

        let issued_props = IssuanceNote::properties();
        let mut issued_options = NoteViewerOptions::<IssuanceNote, <IssuanceNote as Packable>::N>::new();
        issued_options.select(issued_props.company, Comparator.EQ, company)
            .select(issued_props.epoch, Comparator.EQ, epoch);
        let issued_notes = self.storage.issued.at(owner).view_notes(issued_options);

        let mut funded = 0 as Field;
        for i in 0..MAX_NOTES_PER_PAGE {
            if i < funding_notes.len() {
                let note = funding_notes.get_unchecked(i);
                if (note.company == company) & (note.epoch == epoch) {
                    funded += note.amount;
                }
            }
        }

        let mut issued = 0 as Field;
        for i in 0..MAX_NOTES_PER_PAGE {
            if i < issued_notes.len() {
                let note = issued_notes.get_unchecked(i);
                if (note.company == company) & (note.epoch == epoch) {
                    issued += note.amount;
                }
            }
        }
        funded == issued
    }

    /// Employee's salary notes (only they can decrypt these). Paginates across
    /// pages so the full history is returned, not just the first page.
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
