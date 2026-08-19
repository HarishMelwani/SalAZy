/// SalAZy - fully private payroll on Aztec.
///
/// Employers run payroll without revealing who was paid how much, or even the
/// total they deposited. Every salary is a private note encrypted to the
/// employee's keypair; the employer's funding and issuance ledgers are private
/// notes too. A zero-knowledge `prove_fully_paid` asserts that what was issued
/// equals what was funded for a pay period - revealing zero individual amounts.
///
/// Employees discover their paychecks via non-interactive handshakes anchored in
/// the canonical HandshakeRegistry, so they need no prior registration.
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
    use aztec::utils::comparison::Comparator;

    /// Maximum number of employees paid in a single private transaction.
    global MAX_EMPLOYEES_PER_PAYRUN: u32 = 8;

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

    /// A paycheck, encrypted to the employee who may claim it.
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
        paychecks: Owned<PrivateSet<SalaryNote, Context>, Context>,
        balances: Owned<PrivateSet<SalaryNote, Context>, Context>,
    }

    #[external("private")]
    #[initializer]
    fn constructor() {}

    /// Funds a pay period. The deposit is a private note in the employer's own
    /// ledger; no one can see the amount.
    #[external("private")]
    fn fund(company: Field, epoch: Field, amount: Field) {
        let employer = self.msg_sender();
        let note = FundingNote { company, epoch, amount };
        self.storage.funding.at(employer).insert(note).deliver(MessageDelivery::onchain_unconstrained());
    }

    /// Issues a single salary: a paycheck encrypted to `employee`, plus a matching
    /// entry in the employer's private issuance ledger.
    #[external("private")]
    fn issue_salary(company: Field, epoch: Field, employee: AztecAddress, amount: Field, role: Field) {
        self.internal.insert_paycheck(company, epoch, employee, amount, role);
        let employer = self.msg_sender();
        let issuance = IssuanceNote { company, epoch, amount };
        self.storage.issued.at(employer).insert(issuance).deliver(MessageDelivery::onchain_unconstrained());
    }

    /// Pays every employee in one private transaction. Zero-address slots are
    /// skipped, so the array can be padded from the frontend.
    #[external("private")]
    fn issue_salaries(company: Field, epoch: Field, employees: [Employee; MAX_EMPLOYEES_PER_PAYRUN]) {
        let employer = self.msg_sender();
        for i in 0..MAX_EMPLOYEES_PER_PAYRUN {
            let employee = employees[i];
            if !employee.address.is_zero() {
                self.internal.insert_paycheck(company, epoch, employee.address, employee.amount, employee.role);
                let issuance = IssuanceNote { company, epoch, amount: employee.amount };
                self.storage.issued.at(employer).insert(issuance).deliver(MessageDelivery::onchain_unconstrained());
            }
        }
    }

    /// Employee claims every paycheck from `epoch`: the notes are nullified
    /// (spent) and re-inserted into the employee's private balance ledger.
    #[external("private")]
    fn claim_salary(epoch: Field) {
        let employee = self.msg_sender();
        let props = SalaryNote::properties();
        let mut options = NoteGetterOptions::<SalaryNote, <SalaryNote as Packable>::N, Field, Field>::new();
        options.select(props.epoch, Comparator.EQ, epoch);
        let paychecks = self.storage.paychecks.at(employee).pop_notes(options);
        for i in 0..MAX_NOTE_HASH_READ_REQUESTS_PER_CALL {
            if i < paychecks.len() {
                let note = paychecks.get_unchecked(i);
                self.storage.balances.at(employee).insert(note).deliver(MessageDelivery::onchain_unconstrained());
            }
        }
    }

    /// ZERO-KNOWLEDGE PROOF: asserts that what the employer issued equals what it
    /// funded for `company` at `epoch`. Both ledgers are private, so no individual
    /// amount is ever revealed - the transaction landing IS the proof.
    #[external("private")]
    fn prove_fully_paid(company: Field, epoch: Field) {
        let funded = self.internal.sum_funding(company, epoch);
        let issued = self.internal.sum_issued(company, epoch);
        assert(funded == issued, "SalAZy: issued != funded for this period");
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

    /// Inserts a paycheck into an employee's inbox, encrypted to them and
    /// discovered via a non-interactive handshake (no prior registration needed).
    #[internal("private")]
    fn insert_paycheck(company: Field, epoch: Field, employee: AztecAddress, amount: Field, role: Field) {
        let note = SalaryNote { company, epoch, amount, role };
        self.storage.paychecks.at(employee).insert(note).deliver(
            MessageDelivery::onchain_unconstrained().via_non_interactive_handshake(),
        );
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

    /// Employee's incoming paychecks (only they can decrypt these).
    #[external("utility")]
    unconstrained fn view_paychecks(owner: AztecAddress) -> BoundedVec<SalaryNote, MAX_NOTES_PER_PAGE> {
        let options = NoteViewerOptions::<SalaryNote, <SalaryNote as Packable>::N>::new();
        self.storage.paychecks.at(owner).view_notes(options)
    }

    /// Employee's claimed balance (sum across all pay periods).
    #[external("utility")]
    unconstrained fn view_balance(owner: AztecAddress) -> Field {
        let options = NoteViewerOptions::<SalaryNote, <SalaryNote as Packable>::N>::new();
        let notes = self.storage.balances.at(owner).view_notes(options);
        let mut total = 0 as Field;
        for i in 0..MAX_NOTES_PER_PAGE {
            if i < notes.len() {
                total += notes.get_unchecked(i).amount;
            }
        }
        total
    }
}
