import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AztecAddress } from '@aztec/aztec.js/addresses';
import type { EmbeddedWallet } from '@aztec/wallets/embedded';
import type { SalAZyContract } from './generated/SalAZy';
import { registerSponsoredFPC } from './fees';
import { SALAZY_CONTRACT_ADDRESS } from './config';
import { createWallet, createSessionAccount } from './wallet';
import {
  attachToSalAZy,
  encodeField,
  fund,
  isFullyPaid,
  issueSalaries,
  MAX_EMPLOYEES_PER_PAYRUN,
  proveFullyPaid,
  viewBalance,
  viewBalanceNotes,
  viewFunding,
  viewIssued,
  type EmployeeInput,
  type SalaryNote,
} from './salazy';
import './App.css';

const STORAGE_KEY = 'salazy.businesses.v1';

type EmployeeRow = {
  id: string;
  name: string;
  address: string;
  salary: string;
  role: string;
};

type Business = {
  id: string;
  name: string;
  epoch: number;
  employees: EmployeeRow[];
};

type Payroll = {
  epoch: string;
  funded: bigint;
  issued: bigint;
  fullyPaid: boolean;
};

type LogLine = { time: string; text: string; err?: boolean };

function shortAddress(addr: string, n = 10) {
  return addr.length > n * 2 ? `${addr.slice(0, n)}…${addr.slice(-n)}` : addr;
}

function parseAmount(s: string): bigint | null {
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s.trim());
  if (!m) return null;
  const frac = (m[2] ?? '').padEnd(2, '0');
  return BigInt(m[1]) * 100n + BigInt(frac || '0');
}

function formatAmount(n: bigint): string {
  const s = n.toString().padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

function loadBusinesses(): Business[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Business[]) : [];
  } catch {
    return [];
  }
}

function App() {
  const [employer, setEmployer] = useState<{
    address: AztecAddress;
    contract: SalAZyContract;
  } | null>(null);
  const [employee, setEmployee] = useState<{
    address: AztecAddress;
    contract: SalAZyContract;
  } | null>(null);
  const [walletRef] = useState<{ employer: EmbeddedWallet | null; employee: EmbeddedWallet | null }>({
    employer: null,
    employee: null,
  });
  const [connecting, setConnecting] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [tab, setTab] = useState<'employer' | 'employee'>('employer');

  const [businesses, setBusinesses] = useState<Business[]>(loadBusinesses);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newBusinessName, setNewBusinessName] = useState('');
  const [employeeForm, setEmployeeForm] = useState({
    name: '',
    address: '',
    salary: '',
    role: '',
  });
  const [fundAmount, setFundAmount] = useState('');
  const [payroll, setPayroll] = useState<Payroll | null>(null);
  const [paychecks, setPaychecks] = useState<SalaryNote[]>([]);
  const [balance, setBalance] = useState<bigint>(0n);
  const [busy, setBusy] = useState<string>('');
  const [log, setLog] = useState<LogLine[]>([]);
  const [toast, setToast] = useState<string>('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const lastPaycheckCount = useRef<number | null>(null);

  function addLog(text: string, err = false) {
    setLog((l) => [
      ...l.slice(-99),
      { time: new Date().toLocaleTimeString(), text, err },
    ]);
  }

  function showToast(text: string) {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 3500);
  }

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(businesses));
  }, [businesses]);

  const selected = businesses.find((b) => b.id === selectedId) ?? null;

  const saveBusiness = useCallback((next: Business[]) => {
    setBusinesses(next);
  }, []);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    setError('');
    try {
      setStatus('Opening your wallet…');
      const wallet = await createWallet({ proverEnabled: true, onProgress: setStatus });
      walletRef.employer = wallet;
      walletRef.employee = wallet;
      const account = await createSessionAccount(wallet);
      setStatus('Registering fee contracts…');
      await registerSponsoredFPC(wallet);
      const contract = await attachToSalAZy(wallet);
      setEmployer({ address: account.address, contract });
      setEmployee({ address: account.address, contract });
      addLog(`Wallet ready ${shortAddress(account.address.toString())}`);
      setStatus('Ready');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Setup failed: ${msg}`);
      addLog(`Error: ${msg}`, true);
    } finally {
      setConnecting(false);
      setStatus('');
    }
  }, [walletRef]);

  const refreshPayroll = useCallback(
    async (b: Business) => {
      if (!employer) return;
      const company = encodeField(b.name);
      try {
        const funded = await viewFunding(employer.contract, employer.address, company, BigInt(b.epoch));
        const issued = await viewIssued(employer.contract, employer.address, company, BigInt(b.epoch));
        const fullyPaid = await isFullyPaid(employer.contract, employer.address, company, BigInt(b.epoch));
        setPayroll({ epoch: String(b.epoch), funded, issued, fullyPaid });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        addLog(`Payroll view error: ${msg}`, true);
      }
    },
    [employer],
  );

  const refreshEmployee = useCallback(async () => {
    if (!employee) return;
    try {
      const [notes, bal] = await Promise.all([
        viewBalanceNotes(employee.contract, employee.address),
        viewBalance(employee.contract, employee.address),
      ]);
      setPaychecks(notes);
      setBalance(bal);
      if (notes.length !== lastPaycheckCount.current) {
        addLog(`Balance refreshed · ${notes.length} salary note${notes.length === 1 ? '' : 's'}`);
        lastPaycheckCount.current = notes.length;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog(`Employee view error: ${msg}`, true);
    }
  }, [employee]);

  useEffect(() => {
    if (!employer || !selected) return;
    refreshPayroll(selected);
  }, [employer, selected, refreshPayroll]);

  useEffect(() => {
    if (!employee) return;
    refreshEmployee();
    const id = setInterval(refreshEmployee, 10000);
    return () => clearInterval(id);
  }, [employee, refreshEmployee]);

  const createBusiness = useCallback(() => {
    const name = newBusinessName.trim();
    if (!name) return;
    const id = crypto.randomUUID();
    const next = [...businesses, { id, name, epoch: 1, employees: [] }];
    saveBusiness(next);
    setSelectedId(id);
    setNewBusinessName('');
    addLog(`Created business "${name}"`);
  }, [businesses, newBusinessName, saveBusiness]);

  const addEmployee = useCallback(() => {
    if (!selected) return;
    const name = employeeForm.name.trim();
    const address = employeeForm.address.trim();
    if (!name || !address) {
      setError('Name and wallet address are required');
      return;
    }
    if (parseAmount(employeeForm.salary) === null && employeeForm.salary.trim() !== '') {
      setError('Salary must be a number like 1200.00');
      return;
    }
    const next = businesses.map((b) =>
      b.id === selected.id
        ? {
            ...b,
            employees: [
              ...b.employees,
              {
                id: crypto.randomUUID(),
                name,
                address,
                salary: employeeForm.salary.trim() || '0',
                role: employeeForm.role.trim(),
              },
            ],
          }
        : b,
    );
    saveBusiness(next);
    setEmployeeForm({ name: '', address: '', salary: '', role: '' });
    addLog(`Added employee ${name}`);
  }, [businesses, selected, employeeForm, saveBusiness]);

  const removeEmployee = useCallback(
    (empId: string) => {
      if (!selected) return;
      saveBusiness(
        businesses.map((b) =>
          b.id === selected.id
            ? { ...b, employees: b.employees.filter((e) => e.id !== empId) }
            : b,
        ),
      );
    },
    [businesses, selected, saveBusiness],
  );

  const salaryTotal = selected
    ? selected.employees.reduce(
        (sum, e) => sum + (parseAmount(e.salary) ?? 0n),
        0n,
      )
    : 0n;

  const activeEmployees = useMemo(
    () => (selected ? selected.employees.filter((e) => e.address.trim()) : []),
    [selected],
  );
  const currentPayroll =
    payroll && selected && payroll.epoch === String(selected.epoch) ? payroll : null;
  const payrollShortfall =
    currentPayroll && salaryTotal > 0n && currentPayroll.funded < salaryTotal
      ? salaryTotal - currentPayroll.funded
      : null;
  const fundedOk =
    currentPayroll !== null && salaryTotal > 0n && currentPayroll.funded >= salaryTotal;
  const canPay = activeEmployees.length > 0 && fundedOk;

  const handleFund = useCallback(async () => {
    if (!employer || !selected) return;
    const amount = parseAmount(fundAmount);
    if (amount === null || amount <= 0n) {
      setError('Enter a valid funding amount');
      return;
    }
    setBusy('fund');
    setError('');
    try {
      const company = encodeField(selected.name);
      addLog(`Proving & funding epoch ${selected.epoch}…`);
      await fund(employer.contract, employer.address, company, BigInt(selected.epoch), amount);
      addLog(`Funded ${formatAmount(amount)} for epoch ${selected.epoch}`);
      setFundAmount('');
      setTimeout(() => refreshPayroll(selected), 4000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Fund failed: ${msg}`);
      addLog(`Fund error: ${msg}`, true);
    } finally {
      setBusy('');
    }
  }, [employer, selected, fundAmount, refreshPayroll]);

  const handlePayEveryone = useCallback(async () => {
    if (!employer || !selected) return;
    const rows = activeEmployees;
    if (rows.length === 0) {
      setError('Add at least one employee first');
      return;
    }
    if (payrollShortfall !== null) {
      setError(
        `Fund ${formatAmount(payrollShortfall)} more first — ${formatAmount(currentPayroll?.funded ?? 0n)} funded of ${formatAmount(salaryTotal)} required`,
      );
      addLog(`Blocked: funding insufficient for epoch ${selected.epoch}`, true);
      return;
    }
    for (const e of rows) {
      if (parseAmount(e.salary) === null) {
        setError(`Invalid salary for ${e.name}`);
        return;
      }
      try {
        AztecAddress.fromStringUnsafe(e.address.trim());
      } catch {
        setError(`Invalid wallet address for ${e.name}`);
        return;
      }
    }
    setBusy('pay');
    setError('');
    try {
      const company = encodeField(selected.name);
      const employees = rows.map((e) => ({
        address: AztecAddress.fromStringUnsafe(e.address.trim()),
        amount: parseAmount(e.salary)!,
        role: encodeField(e.role),
      }));
      const batches: EmployeeInput[][] = [];
      for (let i = 0; i < employees.length; i += MAX_EMPLOYEES_PER_PAYRUN) {
        batches.push(employees.slice(i, i + MAX_EMPLOYEES_PER_PAYRUN));
      }
      for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];
        addLog(
          `Proving batch pay ${b + 1}/${batches.length} (${batch.length} employee${batch.length === 1 ? '' : 's'})…`,
        );
        await issueSalaries(employer.contract, employer.address, company, BigInt(selected.epoch), batch);
      }
      addLog(`Paid ${rows.length} employee${rows.length === 1 ? '' : 's'} privately (epoch ${selected.epoch})`);
      showToast(`Paid ${rows.length} employee${rows.length === 1 ? '' : 's'} ✓`);
      const next = businesses.map((b) =>
        b.id === selected.id ? { ...b, epoch: b.epoch + 1 } : b,
      );
      saveBusiness(next);
      setPayroll(null);
      setTimeout(() => refreshPayroll({ ...selected, epoch: selected.epoch + 1 }), 4000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Payroll failed: ${msg}`);
      addLog(`Payroll error: ${msg}`, true);
    } finally {
      setBusy('');
    }
  }, [
    employer,
    selected,
    businesses,
    saveBusiness,
    refreshPayroll,
    activeEmployees,
    payrollShortfall,
    currentPayroll,
    salaryTotal,
  ]);

  const handleProve = useCallback(async () => {
    if (!employer || !selected) return;
    setBusy('prove');
    setError('');
    try {
      const company = encodeField(selected.name);
      addLog(`Building ZK proof issued == funded…`);
      await proveFullyPaid(employer.contract, employer.address, company, BigInt(selected.epoch));
      addLog(`✓ PROVED fully paid for epoch ${selected.epoch} — zero amounts revealed`);
      setTimeout(() => refreshPayroll(selected), 4000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Proof failed: ${msg}`);
      addLog(`Proof error: ${msg}`, true);
    } finally {
      setBusy('');
    }
  }, [employer, selected, refreshPayroll]);

  const copyText = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      addLog(`${label} copied to clipboard`);
    } catch {
      addLog('Clipboard unavailable', true);
    }
  }, []);

  const handleResetWallet = useCallback(async () => {
    if (!window.confirm('Reset your wallet? This wipes your saved identity and business data from this browser.')) return;
    localStorage.removeItem(STORAGE_KEY);
    try {
      await Promise.all(
        ['salazy-wallet', 'salazy-pxe'].map(
          (name) =>
            new Promise<void>((resolve) => {
              const req = indexedDB.deleteDatabase(name);
              req.onsuccess = () => resolve();
              req.onerror = () => resolve();
              req.onblocked = () => resolve();
            }),
        ),
      );
    } catch {
      // ignore — reload will still clear in-memory state
    }
    window.location.reload();
  }, []);

  const connected = !!(employer && employee);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <div className="logo">S</div>
          <div>
            <h1>SalAZy</h1>
            <div className="sub">Private payroll on Aztec</div>
          </div>
        </div>
        <div className="status">
          <span className="pulse" />
          Aztec testnet · live
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      {!connected && !connecting && !status && (
        <section className="hero">
          <div className="orb orb-a" />
          <div className="orb orb-b" />
          <p className="eyebrow">ZERO-KNOWLEDGE PAYROLL · AZTEC</p>
          <h2>
            Payroll that only
            <br />
            <em>you</em> can ever see
          </h2>
          <p className="lead">
            Run payroll where no one — not even you, the employer — can see who
            was paid what. Every salary is a zero-knowledge proof encrypted to
            the employee's keypair. Funding is private. A ZK proof attests that
            every salary was paid without revealing a single amount.
          </p>
          <div className="features">
            <div className="feature">
              <span className="dot cyan" />
              Private salaries & funding
            </div>
            <div className="feature">
              <span className="dot magenta" />
              One-click pay everyone
            </div>
            <div className="feature">
              <span className="dot violet" />
              Prove fully paid, zero amounts leaked
            </div>
          </div>
          <button className="btn primary big" onClick={handleConnect} disabled={connecting}>
            Open SalAZy
          </button>
          <p className="hint">
            Opens a single persistent wallet saved in your browser
            (IndexedDB) against the public Aztec testnet. Your identity and
            business data survive refresh — nothing leaves your device.
          </p>
          <div className="ticker">
            <div className="ticker-track">
              {Array.from({ length: 2 }).flatMap((_, k) =>
                Array.from({ length: 6 }).map((__, i) => (
                  <span key={`${k}-${i}`} className={i % 3 === 1 ? 'tick hot' : i % 3 === 2 ? 'tick cool' : 'tick'}>
                    PRIVATE PAYROLL ✦ ZERO-KNOWLEDGE ✦ AZTEC TESTNET ✦
                  </span>
                )),
              )}
            </div>
          </div>
        </section>
      )}

      {(connecting || status) && !connected && (
        <div className="progress">
          <div className="spinner" />
          <p>{status}</p>
        </div>
      )}

      {connected && (
        <main className="layout">
          <nav className="tabs">
            <button
              className={tab === 'employer' ? 'tab active' : 'tab'}
              onClick={() => setTab('employer')}
            >
              Employer
            </button>
            <button
              className={tab === 'employee' ? 'tab active' : 'tab'}
              onClick={() => setTab('employee')}
            >
              Employee
            </button>
          </nav>

          {tab === 'employer' && (
            <div className="dashboard">
              <div className="side-col">
                <div className="card">
                  <div className="card-title">Your businesses</div>
                  {businesses.length === 0 && (
                    <p className="muted">No businesses yet. Create your first one.</p>
                  )}
                  <div className="business-list">
                    {businesses.map((b) => (
                      <button
                        key={b.id}
                        className={`business-row${b.id === selectedId ? ' active' : ''}`}
                        onClick={() => setSelectedId(b.id)}
                      >
                        <span className="bname">{b.name}</span>
                        <span className="bcount">{b.employees.length} emp</span>
                      </button>
                    ))}
                  </div>
                  <div className="row">
                    <input
                      value={newBusinessName}
                      onChange={(e) => setNewBusinessName(e.target.value)}
                      placeholder="Add business name"
                      onKeyDown={(e) => e.key === 'Enter' && createBusiness()}
                    />
                    <button className="btn small" onClick={createBusiness} disabled={!newBusinessName.trim()}>
                      Add
                    </button>
                  </div>
                </div>

                <div className="card identity">
                  <div className="me">
                    <div className="avatar">
                      {employer!.address.toString().slice(2, 4).toUpperCase()}
                    </div>
                    <div className="who">
                      <div className="label">Employer address</div>
                      <code title={employer!.address.toString()}>
                        {shortAddress(employer!.address.toString(), 16)}
                      </code>
                    </div>
                  </div>
                  <div className="actions">
                    <button className="icon-btn" onClick={() => copyText(employer!.address.toString(), 'Employer address')}>
                      Copy
                    </button>
                    <button className="icon-btn danger" onClick={handleResetWallet}>
                      Reset identity
                    </button>
                  </div>
                  <p className="muted hint">
                    This wallet is saved in your browser — same address every
                    visit. Reset to mint a fresh one (wipes local data).
                  </p>
                </div>

                <details className="card log">
                  <summary>Session activity</summary>
                  <div className="log-inner" ref={logRef}>
                    {log.map((l, i) => (
                      <div className={`log-line${l.err ? ' err' : ''}`} key={i}>
                        <span className="time">{l.time}</span>
                        {l.text}
                      </div>
                    ))}
                  </div>
                </details>
              </div>

              <div className="main-col">
                {!selected ? (
                  <div className="empty">
                    <div className="glyph">🪙</div>
                    <p>Select a business or create one</p>
                    <div className="sub">
                      Each business keeps its own employee list and payroll.
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="card head">
                      <div>
                        <div className="card-title">{selected.name}</div>
                        <div className="muted">
                          Period (epoch) #{selected.epoch} · {selected.employees.length} employee
                          {selected.employees.length === 1 ? '' : 's'} · payroll{' '}
                          {formatAmount(salaryTotal)}
                        </div>
                      </div>
                      {payroll && (
                        <div className="payroll-chips">
                          <div className="chip">
                            <span className="chip-lbl">Funded</span>
                            <span className="chip-val">{formatAmount(payroll.funded)}</span>
                          </div>
                          <div className="chip">
                            <span className="chip-lbl">Issued</span>
                            <span className="chip-val">{formatAmount(payroll.issued)}</span>
                          </div>
                          {payroll.funded === 0n && payroll.issued === 0n ? (
                            <div className="chip muted-chip">Not started</div>
                          ) : payroll.fullyPaid ? (
                            <div className="chip ok-chip">Fully paid ✓</div>
                          ) : (
                            <div className="chip warn-chip">Partial</div>
                          )}
                          {payroll.funded > payroll.issued && (
                            <div className="chip remain-chip">
                              <span className="chip-lbl">Remaining</span>
                              <span className="chip-val">
                                {formatAmount(payroll.funded - payroll.issued)}
                              </span>
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    <div className="card">
                      <div className="card-title">Employees</div>
                      {selected.employees.length === 0 && (
                        <p className="muted">
                          Add your first employee. Use the address shown in the
                          Employee tab as a wallet address to pay yourself.
                        </p>
                      )}
                      <div className="emp-table">
                        <div className="emp-head">
                          <span>Name</span>
                          <span>Wallet</span>
                          <span>Salary</span>
                          <span>Role</span>
                          <span />
                        </div>
                        {selected.employees.map((e) => (
                          <div className="emp-row" key={e.id}>
                            <span className="emp-name">{e.name}</span>
                            <code className="emp-addr">{shortAddress(e.address, 8)}</code>
                            <span>{e.salary || '—'}</span>
                            <span>{e.role || '—'}</span>
                            <button className="icon-btn danger" onClick={() => removeEmployee(e.id)}>
                              ✕
                            </button>
                          </div>
                        ))}
                      </div>
                      <div className="emp-form">
                        <input
                          value={employeeForm.name}
                          onChange={(e) => setEmployeeForm({ ...employeeForm, name: e.target.value })}
                          placeholder="Name"
                        />
                        <input
                          value={employeeForm.address}
                          onChange={(e) => setEmployeeForm({ ...employeeForm, address: e.target.value })}
                          placeholder="Wallet (Aztec address)"
                          spellCheck={false}
                        />
                        <input
                          value={employeeForm.salary}
                          onChange={(e) => setEmployeeForm({ ...employeeForm, salary: e.target.value })}
                          placeholder="Salary (1200.00)"
                        />
                        <input
                          value={employeeForm.role}
                          onChange={(e) => setEmployeeForm({ ...employeeForm, role: e.target.value })}
                          placeholder="Role (optional)"
                        />
                        <button className="btn small" onClick={addEmployee}>
                          Add employee
                        </button>
                      </div>
                    </div>

                    <div className="card">
                      <div className="card-title">Payroll · epoch {selected.epoch}</div>
                      <p className="muted">
                        Fund the period, then pay everyone with one click. Each
                        salary is a private encrypted note — amounts stay hidden.
                      </p>
                      <div className="payroll-actions">
                        <div className="row grow">
                          <input
                            value={fundAmount}
                            onChange={(e) => setFundAmount(e.target.value)}
                            placeholder={`Fund amount (suggested ${formatAmount(salaryTotal)})`}
                          />
                          <button
                            className="btn"
                            onClick={handleFund}
                            disabled={busy === 'fund' || !fundAmount.trim()}
                          >
                            {busy === 'fund' ? 'Funding…' : 'Fund'}
                          </button>
                        </div>
                        <button
                          className="btn primary"
                          onClick={handlePayEveryone}
                          disabled={busy === 'pay' || !canPay}
                          title={
                            payrollShortfall !== null
                              ? `Fund ${formatAmount(payrollShortfall)} more to cover payroll`
                              : !fundedOk
                                ? 'Syncing on-chain funding…'
                                : activeEmployees.length === 0
                                  ? 'Add employees first'
                                  : 'Pay everyone privately'
                          }
                        >
                          {busy === 'pay'
                            ? 'Paying everyone…'
                            : payrollShortfall !== null
                              ? 'Fund required first'
                              : 'Pay everyone'}
                        </button>
                        {payrollShortfall !== null && (
                          <div
                            className="pay-note"
                            onClick={() => setFundAmount(formatAmount(payrollShortfall))}
                          >
                            <span className="pay-note-dot" />
                            {formatAmount(currentPayroll!.funded)} funded of{' '}
                            {formatAmount(salaryTotal)} required — fund{' '}
                            <strong>{formatAmount(payrollShortfall)}</strong> more to unlock
                            payment <span className="pay-fill">click to fill ↦</span>
                          </div>
                        )}
                        {payrollShortfall === null &&
                          !fundedOk &&
                          activeEmployees.length > 0 &&
                          salaryTotal > 0n && (
                            <div className="pay-note pending">
                              <span className="pay-note-dot" />
                              Checking on-chain funding…
                            </div>
                          )}
                        {fundedOk && (
                          <div className="pay-note ok">
                            <span className="pay-note-dot" />
                            Fully funded · ready to pay {formatAmount(salaryTotal)}
                          </div>
                        )}
                        <button
                          className="btn outline"
                          onClick={handleProve}
                          disabled={busy === 'prove'}
                        >
                          {busy === 'prove' ? 'Proving…' : 'Prove fully paid'}
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {tab === 'employee' && (
            <div className="dashboard">
              <div className="side-col">
                <div className="card identity">
                  <div className="me">
                    <div className="avatar">
                      {employee!.address.toString().slice(2, 4).toUpperCase()}
                    </div>
                    <div className="who">
                      <div className="label">Your wallet</div>
                      <code title={employee!.address.toString()}>
                        {shortAddress(employee!.address.toString(), 16)}
                      </code>
                    </div>
                  </div>
                  <div className="actions">
                    <button
                      className="icon-btn"
                      onClick={() => copyText(employee!.address.toString(), 'Wallet address')}
                    >
                      Copy
                    </button>
                  </div>
                  <p className="muted hint">
                    This is your one wallet — employer and employee in one.
                    Use it as your own employee address to pay yourself.
                  </p>
                </div>

                <div className="card">
                  <div className="stats">
                    <div className="stat">
                      <div className="num jade">{paychecks.length}</div>
                      <div className="lbl">Incoming</div>
                    </div>
                    <div className="stat">
                      <div className="num gold">{formatAmount(balance)}</div>
                      <div className="lbl">Balance</div>
                    </div>
                    <div className="stat">
                      <div className="num rose">{log.length}</div>
                      <div className="lbl">Actions</div>
                    </div>
                    <div className="stat">
                      <div className="num">24/7</div>
                      <div className="lbl">On-chain</div>
                    </div>
                  </div>
                </div>

                <details className="card log">
                  <summary>Session activity</summary>
                  <div className="log-inner" ref={logRef}>
                    {log.map((l, i) => (
                      <div className={`log-line${l.err ? ' err' : ''}`} key={i}>
                        <span className="time">{l.time}</span>
                        {l.text}
                      </div>
                    ))}
                  </div>
                </details>
              </div>

              <div className="main-col">
                <div className="card">
                  <div className="card-title">Incoming paychecks</div>
                  {paychecks.length === 0 ? (
                    <div className="empty">
                      <div className="glyph">🔒</div>
                      <p>No paychecks yet</p>
                      <div className="sub">
                        Once you pay a salary to your own address, it appears here —
                        encrypted to your keypair only.
                      </div>
                    </div>
                  ) : (
                    <div className="pc-list">
                      {paychecks.map((p, i) => (
                        <div className="pc-row" key={i}>
                          <div>
                            <div className="pc-company">{p.company || '—'}</div>
                            <div className="pc-meta">
                              epoch {p.epoch} · {p.role || 'no role'}
                            </div>
                          </div>
                          <div className="pc-side">
                            <span className="pc-amount">{formatAmount(p.amount)}</span>
                            <span className="pc-deposited">credited</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="card">
                  <div className="card-title">Balance</div>
                  <div className="balance-big">{formatAmount(balance)}</div>
                  <p className="muted">
                    Salaries land here the moment payroll runs — nothing to
                    claim. Only you can ever see them.
                  </p>
                </div>
              </div>
            </div>
          )}
        </main>
      )}

      <footer className="footer">
        <div>
          Contract <code>{shortAddress(SALAZY_CONTRACT_ADDRESS, 14)}</code>
        </div>
        <div>Aztec testnet · embedded wallets · no servers</div>
      </footer>

      {toast && <div className="toast-pop">{toast}</div>}
    </div>
  );
}

export default App;
