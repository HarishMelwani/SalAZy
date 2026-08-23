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
  fieldFromString,
  fund,
  isFullyPaid,
  issueSalaries,
  MAX_EMPLOYEES_PER_PAYRUN,
  proveFullyPaid,
  randomCompanyId,
  textFitsField,
  viewBalance,
  viewBalanceNotes,
  viewFunding,
  viewIssued,
  type EmployeeInput,
  type SalaryNote,
} from './salazy';
import './App.css';

const STORAGE_KEY = 'salazy.businesses.v1';
const TX_HISTORY_KEY = 'salazy.txhistory.v1';
const PROVED_KEY = 'salazy.proved.v1';
const PAID_KEY = 'salazy.paid.v1';
const PLANNED_KEY = 'salazy.planned.v1';
const ROLLOVER_KEY = 'salazy.rollover.v1';
const TOPUPS_KEY = 'salazy.topups.v1';
const TX_HISTORY_MAX = 20;

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
  /** Stable on-chain company Field (decimal string). Never changes, even on rename. */
  companyId: string;
  epoch: number;
  employees: EmployeeRow[];
};

type Payroll = {
  epoch: string;
  funded: bigint;
  issued: bigint;
  fullyPaid: boolean;
};

type EpochRecord = {
  epoch: number;
  funded: bigint;
  issued: bigint;
  proved: boolean;
};

type LogLine = { time: string; text: string; err?: boolean };

type TxRecord = {
  id: string;
  action: 'fund' | 'pay' | 'prove';
  label: string;
  hash: string;
  time: string;
};

function shortAddress(addr: string, n = 10) {
  return addr.length > n * 2 ? `${addr.slice(0, n)}…${addr.slice(-n)}` : addr;
}

function isValidAztecAddress(addr: string): boolean {
  try {
    AztecAddress.fromStringUnsafe(addr.trim());
    return true;
  } catch {
    return false;
  }
}

/**
 * A redeploy replaces content-hashed chunks, so a tab that stayed open across
 * a deploy fails its next lazy import ("Failed to fetch dynamically imported
 * module"). Detect that and reload once to pick up the fresh bundle.
 */
function isChunkLoadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /failed to fetch dynamically imported module/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg) ||
    /importing a module script failed/i.test(msg)
  );
}

const CHUNK_RELOAD_FLAG = 'salazy.chunkReload';

function recoverFromChunkLoadError(): boolean {
  try {
    if (sessionStorage.getItem(CHUNK_RELOAD_FLAG)) return false;
    sessionStorage.setItem(CHUNK_RELOAD_FLAG, String(Date.now()));
  } catch {
    // sessionStorage unavailable; still reload once.
  }
  window.location.reload();
  return true;
}

/** The hashed index bundle this running tab was built from (null in dev). */
function currentBundleSrc(): string | null {
  return (
    document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]')
      ?.getAttribute('src') ?? null
  );
}

async function fetchLatestBundleSrc(): Promise<string | null> {
  try {
    const res = await fetch(`/?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.text()).match(/assets\/index-[A-Za-z0-9_-]+\.js/)?.[0] ?? null;
  } catch {
    return null;
  }
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

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function persistJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage full or unavailable; keep in-memory only.
  }
}

function loadBusinesses(): Business[] {
  const list = loadJson<Business[]>(STORAGE_KEY, []);
  // Migrate: businesses created before stable company ids kept their ledger
  // under the field derived from their name — keep that exact id so existing
  // on-chain notes still match.
  return list.map((b) => ({
    ...b,
    companyId: b.companyId ?? encodeField(b.name).toString(),
  }));
}

/** Resolves a paycheck's company Field to the business name it belongs to. */
function companyNameFor(businesses: Business[], note: SalaryNote): string {
  const match = businesses.find((b) => b.companyId === note.companyRaw);
  return match?.name ?? (note.company || '—');
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
  const [editingBusinessId, setEditingBusinessId] = useState<string | null>(null);
  const [editingBusinessName, setEditingBusinessName] = useState('');
  const [editingEmployeeId, setEditingEmployeeId] = useState<string | null>(null);
  const [editingEmployeeForm, setEditingEmployeeForm] = useState({
    name: '',
    address: '',
    salary: '',
    role: '',
  });
  const [employeeForm, setEmployeeForm] = useState({
    name: '',
    address: '',
    salary: '',
    role: '',
  });
  const [payroll, setPayroll] = useState<Payroll | null>(null);
  const [epochHistory, setEpochHistory] = useState<EpochRecord[]>([]);
  const [paychecks, setPaychecks] = useState<SalaryNote[]>([]);
  const [balance, setBalance] = useState<bigint>(0n);
  const [busy, setBusy] = useState<string>('');
  const [log, setLog] = useState<LogLine[]>([]);
  const [toast, setToast] = useState<string>('');
  const [outdated, setOutdated] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const lastPaycheckCount = useRef<number | null>(null);
  const [txHistory, setTxHistory] = useState<TxRecord[]>(() => {
    try {
      const raw = localStorage.getItem(TX_HISTORY_KEY);
      return raw ? (JSON.parse(raw) as TxRecord[]) : [];
    } catch {
      return [];
    }
  });
  const [provedEpochs, setProvedEpochs] = useState<Record<string, boolean>>(() => {
    try {
      const raw = localStorage.getItem(PROVED_KEY);
      return raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    } catch {
      return {};
    }
  });
  // Employee ids already paid this period: a failed batch mid-payrun can be
  // retried without paying anyone twice.
  const [paidEmployees, setPaidEmployees] = useState<Record<string, string[]>>(() =>
    loadJson<Record<string, string[]>>(PAID_KEY, {}),
  );
  // Cumulative amount actually sent for a period (decimal string). The ZK proof
  // runs against this planned total instead of the on-chain issued amount.
  const [plannedTotals, setPlannedTotals] = useState<Record<string, string>>(() =>
    loadJson<Record<string, string>>(PLANNED_KEY, {}),
  );
  // Where a period's funding came from, for the breakdown under the Funded
  // chip: rollovers keyed by TARGET period, manual top-ups by their period.
  const [rollovers, setRollovers] = useState<Record<string, string>>(() =>
    loadJson<Record<string, string>>(ROLLOVER_KEY, {}),
  );
  const [topups, setTopups] = useState<Record<string, string>>(() =>
    loadJson<Record<string, string>>(TOPUPS_KEY, {}),
  );

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

  function recordTx(action: TxRecord['action'], label: string, hash: string) {
    const record: TxRecord = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      action,
      label,
      hash,
      time: new Date().toLocaleString(),
    };
    setTxHistory((h) => {
      const next = [record, ...h].slice(0, TX_HISTORY_MAX);
      persistJson(TX_HISTORY_KEY, next);
      return next;
    });
  }

  /** Marks employees as paid for a period (persisted immediately after each batch). */
  function markPaid(key: string, ids: string[]) {
    setPaidEmployees((p) => {
      const next = { ...p, [key]: [...(p[key] ?? []), ...ids] };
      persistJson(PAID_KEY, next);
      return next;
    });
  }

  /** Adds to the period's planned total — what was actually sent on-chain. */
  function addPlanned(key: string, amount: bigint) {
    if (amount === 0n) return;
    setPlannedTotals((p) => {
      const next = { ...p, [key]: (BigInt(p[key] ?? '0') + amount).toString() };
      persistJson(PLANNED_KEY, next);
      return next;
    });
  }

  /** Records how much was rolled INTO a period (breakdown display). */
  function recordRollover(key: string, amount: bigint) {
    if (amount === 0n) return;
    setRollovers((p) => {
      const next = { ...p, [key]: (BigInt(p[key] ?? '0') + amount).toString() };
      persistJson(ROLLOVER_KEY, next);
      return next;
    });
  }

  /** Records a manual top-up made in a period (breakdown display). */
  function recordTopup(key: string, amount: bigint) {
    if (amount === 0n) return;
    setTopups((p) => {
      const next = { ...p, [key]: (BigInt(p[key] ?? '0') + amount).toString() };
      persistJson(TOPUPS_KEY, next);
      return next;
    });
  }

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(businesses));
  }, [businesses]);

  const selected = businesses.find((b) => b.id === selectedId) ?? null;
  const connected = !!(employer && employee);

  const periodKey = selected ? `${selected.id}:${selected.epoch}` : '';
  const isProved = periodKey ? !!provedEpochs[periodKey] : false;

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
      if (isChunkLoadError(err) && recoverFromChunkLoadError()) return;
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Setup failed: ${msg}`);
      addLog(`Error: ${msg}`, true);
    } finally {
      setConnecting(false);
      setStatus('');
    }
  }, [walletRef]);

  const handleDisconnect = useCallback(() => {
    walletRef.employer = null;
    walletRef.employee = null;
    setEmployer(null);
    setEmployee(null);
    setTab('employer');
    setSelectedId(null);
    setNewBusinessName('');
    setPayroll(null);
    setPaychecks([]);
    setBalance(0n);
    setBusy('');
    setLog([]);
    setError('');
    addLog('Disconnected');
  }, [walletRef]);

  const refreshPayroll = useCallback(
    async (b: Business) => {
      if (!employer) return;
      const company = fieldFromString(b.companyId);
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

  const refreshEpochHistory = useCallback(async () => {
    if (!employer || !selected) return;
    const company = fieldFromString(selected.companyId);
    const records: EpochRecord[] = [];
    const startEpoch = Math.max(1, selected.epoch - 20);
    for (let e = selected.epoch; e >= startEpoch; e--) {
      try {
        const [funded, issued] = await Promise.all([
          viewFunding(employer.contract, employer.address, company, BigInt(e)),
          viewIssued(employer.contract, employer.address, company, BigInt(e)),
        ]);
        const proved = !!provedEpochs[`${selected.id}:${e}`];
        records.push({ epoch: e, funded, issued, proved });
      } catch {
        records.push({ epoch: e, funded: 0n, issued: 0n, proved: false });
      }
    }
    setEpochHistory(records);
  }, [employer, selected, provedEpochs]);

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
    refreshEpochHistory();
  }, [employer, selected, refreshPayroll, refreshEpochHistory]);

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
    const next = [...businesses, { id, name, companyId: randomCompanyId(), epoch: 1, employees: [] }];
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
    if (!isValidAztecAddress(address)) {
      setError('Wallet address is not a valid Aztec address');
      return;
    }
    if (employeeForm.role.trim() && !textFitsField(employeeForm.role.trim())) {
      setError('Role must be 31 bytes or shorter');
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

  const startEditEmployee = useCallback(
    (empId: string) => {
      if (!selected) return;
      const emp = selected.employees.find((e) => e.id === empId);
      if (!emp) return;
      setEditingEmployeeId(empId);
      setEditingEmployeeForm({
        name: emp.name,
        address: emp.address,
        salary: emp.salary,
        role: emp.role,
      });
    },
    [selected],
  );

  const saveEditEmployee = useCallback(() => {
    if (!selected || !editingEmployeeId) return;
    const name = editingEmployeeForm.name.trim();
    const address = editingEmployeeForm.address.trim();
    if (!name || !address) {
      setError('Name and wallet address are required');
      return;
    }
    if (!isValidAztecAddress(address)) {
      setError('Wallet address is not a valid Aztec address');
      return;
    }
    if (editingEmployeeForm.role.trim() && !textFitsField(editingEmployeeForm.role.trim())) {
      setError('Role must be 31 bytes or shorter');
      return;
    }
    if (parseAmount(editingEmployeeForm.salary) === null && editingEmployeeForm.salary.trim() !== '') {
      setError('Salary must be a number like 1200.00');
      return;
    }
    saveBusiness(
      businesses.map((b) =>
        b.id === selected.id
          ? {
              ...b,
              employees: b.employees.map((e) =>
                e.id === editingEmployeeId
                  ? {
                      ...e,
                      name,
                      address,
                      salary: editingEmployeeForm.salary.trim() || '0',
                      role: editingEmployeeForm.role.trim(),
                    }
                  : e,
              ),
            }
          : b,
      ),
    );
    setEditingEmployeeId(null);
    addLog(`Updated employee ${name}`);
  }, [businesses, selected, editingEmployeeId, editingEmployeeForm, saveBusiness]);

  const startEditBusiness = useCallback(
    (bizId: string) => {
      const biz = businesses.find((b) => b.id === bizId);
      if (!biz) return;
      setEditingBusinessId(bizId);
      setEditingBusinessName(biz.name);
    },
    [businesses],
  );

  const saveEditBusiness = useCallback(() => {
    if (!editingBusinessId) return;
    const name = editingBusinessName.trim();
    if (!name) {
      setError('Business name is required');
      return;
    }
    saveBusiness(businesses.map((b) => (b.id === editingBusinessId ? { ...b, name } : b)));
    setEditingBusinessId(null);
    setEditingBusinessName('');
    addLog(`Renamed business to "${name}"`);
  }, [businesses, editingBusinessId, editingBusinessName, saveBusiness]);

  const activeEmployees = useMemo(
    () => (selected ? selected.employees.filter((e) => e.address.trim()) : []),
    [selected],
  );

  // Planned total must match what issue_salaries actually pays: employees with
  // a non-empty address. Counting address-less rows inflates the total, so the
  // ZK proof fails with "issued != planned total".
  const salaryTotal = activeEmployees.reduce(
    (sum, e) => sum + (parseAmount(e.salary) ?? 0n),
    0n,
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
  // The period is "fully paid out" when the funding pool is exhausted
  // (issued == funded). Gating on salaryTotal instead would lock out further
  // payments while remaining funding still exists.
  const alreadyPaid =
    currentPayroll !== null &&
    currentPayroll.funded > 0n &&
    currentPayroll.issued >= currentPayroll.funded;

  const breakdownParts = useMemo(() => {
    if (!currentPayroll || currentPayroll.funded === 0n) return [] as string[];
    const parts: string[] = [];
    const rolled = BigInt(rollovers[periodKey] ?? '0');
    const topped = BigInt(topups[periodKey] ?? '0');
    if (rolled > 0n) parts.push(`${formatAmount(rolled)} carried over`);
    if (topped > 0n) parts.push(`${formatAmount(topped)} funded here`);
    return parts;
  }, [currentPayroll, rollovers, topups, periodKey]);

  // Show the carry-over offer until the leftover has actually been moved.
  // Unspent funding from the previous period, offered to carry into this one.
  const prevEpochLeftover = useMemo(() => {
    if (!selected || selected.epoch <= 1) return 0n;
    const rec = epochHistory.find((r) => r.epoch === selected.epoch - 1);
    if (!rec || rec.funded <= rec.issued) return 0n;
    return rec.funded - rec.issued;
  }, [selected, epochHistory]);

  const showCarryOver =
    prevEpochLeftover > 0n && BigInt(rollovers[periodKey] ?? '0') === 0n;

  // Exact shortfall to fund this period (display only — the tx re-reads
  // on-chain funding right before sending, so it can never over/under-fund).
  const fundNeeded = currentPayroll
    ? currentPayroll.funded >= salaryTotal
      ? 0n
      : salaryTotal - currentPayroll.funded
    : salaryTotal;

  const handleFund = useCallback(async () => {
    if (!employer || !selected) return;
    setBusy('fund');
    setError('');
    try {
      const company = fieldFromString(selected.companyId);
      // Exact funding: read FRESH on-chain funding right before sending, so
      // the tx is precisely the shortfall — never more, never less — even if
      // the cached view is behind or a carry-over just landed.
      const freshFunded = await viewFunding(
        employer.contract,
        employer.address,
        company,
        BigInt(selected.epoch),
      ).catch(() => 0n);
      const needed = salaryTotal > freshFunded ? salaryTotal - freshFunded : 0n;
      if (needed === 0n) {
        setError('This period is already fully funded');
        addLog('Blocked: period already fully funded', true);
        return;
      }
      addLog(`Funding the exact shortfall for epoch ${selected.epoch}: ${formatAmount(needed)}…`);
      const txHash = await fund(employer.contract, employer.address, company, BigInt(selected.epoch), needed);
      addLog(`Funded ${formatAmount(needed)} for epoch ${selected.epoch} · tx ${shortAddress(txHash, 8)}`);
      recordTx('fund', `Fund ${formatAmount(needed)} (epoch ${selected.epoch})`, txHash);
      recordTopup(periodKey, needed);
      setTimeout(() => refreshPayroll(selected), 4000);
    } catch (err) {
      if (isChunkLoadError(err) && recoverFromChunkLoadError()) return;
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Fund failed: ${msg}`);
      addLog(`Fund error: ${msg}`, true);
    } finally {
      setBusy('');
    }
  }, [employer, selected, refreshPayroll, periodKey, salaryTotal]);

  const handlePayEveryone = useCallback(async () => {
    if (!employer || !selected) return;
    const paidSet = new Set(paidEmployees[periodKey] ?? []);
    const rows = activeEmployees.filter((e) => !paidSet.has(e.id));
    if (activeEmployees.length === 0) {
      setError('Add at least one employee first');
      return;
    }
    if (rows.length === 0) {
      setError(
        'Everyone on this list was already paid this period — start a new period to pay again',
      );
      addLog('Blocked: every employee was already paid this period', true);
      return;
    }
    if (alreadyPaid) {
      // Funding pool exhausted (issued == funded) but people are still unpaid:
      // topping up the period unlocks the rest.
      setError(
        `This period's funding is fully issued — fund more to pay the remaining ${rows.length} employee${rows.length === 1 ? '' : 's'}`,
      );
      addLog(`Blocked: period funding exhausted, ${rows.length} unpaid`, true);
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
      const pay = parseAmount(e.salary);
      if (pay === null || pay === 0n) {
        setError(`Salary for ${e.name} must be a number greater than 0`);
        return;
      }
      if (!isValidAztecAddress(e.address)) {
        setError(`Invalid wallet address for ${e.name}`);
        return;
      }
    }
    setBusy('pay');
    setError('');
    try {
      const company = fieldFromString(selected.companyId);
      const entries: { id: string; input: EmployeeInput }[] = rows.map((e) => ({
        id: e.id,
        input: {
          address: AztecAddress.fromStringUnsafe(e.address.trim()),
          amount: parseAmount(e.salary)!,
          role: encodeField(e.role),
        },
      }));
      const batches: typeof entries[] = [];
      for (let i = 0; i < entries.length; i += MAX_EMPLOYEES_PER_PAYRUN) {
        batches.push(entries.slice(i, i + MAX_EMPLOYEES_PER_PAYRUN));
      }
      const alreadyCount = activeEmployees.length - rows.length;
      const hashes: string[] = [];
      for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];
        addLog(
          `Paying batch ${b + 1}/${batches.length} (${batch.length} employee${batch.length === 1 ? '' : 's'})…`,
        );
        const txHash = await issueSalaries(
          employer.contract,
          employer.address,
          company,
          BigInt(selected.epoch),
          batch.map((x) => x.input),
        );
        hashes.push(txHash);
        // Persist progress after every batch: a later failure resumes here
        // instead of re-paying this batch.
        markPaid(
          periodKey,
          batch.map((x) => x.id),
        );
        addPlanned(
          periodKey,
          batch.reduce((sum, x) => sum + x.input.amount, 0n),
        );
        recordTx('pay', `Pay ${batch.length} (epoch ${selected.epoch}, batch ${b + 1})`, txHash);
      }
      addLog(
        `Paid ${rows.length} employee${rows.length === 1 ? '' : 's'} privately (epoch ${selected.epoch})${
          alreadyCount > 0 ? ` · ${alreadyCount} already paid earlier` : ''
        } · tx ${hashes.map((h) => shortAddress(h, 8)).join(', ')}`,
      );
      showToast(`Paid ${rows.length} employee${rows.length === 1 ? '' : 's'} ✓`);
      setPayroll(null);
      setProvedEpochs((p) => {
        const next = { ...p, [periodKey]: false };
        try { localStorage.setItem(PROVED_KEY, JSON.stringify(next)); } catch {}
        return next;
      });
      setTimeout(() => refreshPayroll(selected), 4000);
    } catch (err) {
      if (isChunkLoadError(err) && recoverFromChunkLoadError()) return;
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Payroll failed: ${msg}`);
      addLog(`Payroll error: ${msg}`, true);
    } finally {
      setBusy('');
    }
  }, [
    employer,
    selected,
    refreshPayroll,
    activeEmployees,
    payrollShortfall,
    currentPayroll,
    salaryTotal,
    alreadyPaid,
    periodKey,
    paidEmployees,
  ]);

  const handleNextPeriod = useCallback(() => {
    if (!selected) return;
    if (!isProved) {
      setError('Prove this period fully paid before starting the next one');
      addLog('Blocked: prove epoch ' + selected.epoch + ' before advancing', true);
      return;
    }
    // Advancing NEVER transacts (user choice). The new period starts empty;
    // any unspent funding from this period is surfaced as a notice with an
    // explicit "move it here" button in the new period.
    const next = businesses.map((b) =>
      b.id === selected.id ? { ...b, epoch: b.epoch + 1 } : b,
    );
    saveBusiness(next);
    setPayroll(null);
    showToast(`Started period ${selected.epoch + 1}`);
    addLog(`Started period ${selected.epoch + 1}`);
  }, [businesses, selected, saveBusiness, isProved]);

  /** Explicitly moves the previous period's unspent funding into this one. */
  const handleCarryOver = useCallback(async () => {
    if (!employer || !selected || prevEpochLeftover === 0n) return;
    setBusy('carry');
    setError('');
    try {
      const company = fieldFromString(selected.companyId);
      addLog(
        `Moving ${formatAmount(prevEpochLeftover)} from period ${selected.epoch - 1}…`,
      );
      const txHash = await fund(
        employer.contract,
        employer.address,
        company,
        BigInt(selected.epoch),
        prevEpochLeftover,
      );
      recordTx('fund', `Carry over from period ${selected.epoch - 1}`, txHash);
      recordRollover(periodKey, prevEpochLeftover);
      addLog(`Moved ${formatAmount(prevEpochLeftover)} · tx ${shortAddress(txHash, 8)}`);
      showToast(`${formatAmount(prevEpochLeftover)} moved into period ${selected.epoch}`);
      setTimeout(() => refreshPayroll(selected), 4000);
    } catch (err) {
      if (isChunkLoadError(err) && recoverFromChunkLoadError()) return;
      const msg = err instanceof Error ? err.message : String(err);
      setError(`Carry over failed: ${msg}`);
      addLog(`Carry over error: ${msg}`, true);
    } finally {
      setBusy('');
    }
  }, [employer, selected, prevEpochLeftover, refreshPayroll, periodKey]);

  const handleProve = useCallback(async () => {
    if (!employer || !selected) return;
    setBusy('prove');
    setError('');
    try {
      const company = fieldFromString(selected.companyId);
      const [issuedNow, fundedNow] = await Promise.all([
        viewIssued(employer.contract, employer.address, company, BigInt(selected.epoch)).catch(() => 0n),
        viewFunding(employer.contract, employer.address, company, BigInt(selected.epoch)).catch(() => 0n),
      ]);
      addLog(
        `On-chain epoch ${selected.epoch}: issued ${formatAmount(issuedNow)} · funded ${formatAmount(fundedNow)}`,
      );
      if (issuedNow === 0n) {
        setError('Nothing has been issued for this period yet — pay everyone first');
        addLog('Not paid: nothing issued for this period', true);
        return;
      }
      // Prove against what was actually planned and sent, not against the
      // on-chain issued amount (which would make issued == total trivial).
      const plannedRaw = plannedTotals[periodKey];
      const planned = plannedRaw !== undefined ? BigInt(plannedRaw) : null;
      const target = planned ?? issuedNow;
      if (planned !== null && issuedNow !== planned) {
        setError(
          `Issued ${formatAmount(issuedNow)} of ${formatAmount(planned)} planned — pay the remaining employees first`,
        );
        addLog(
          `Not paid: issued ${formatAmount(issuedNow)} != planned ${formatAmount(planned)}`,
          true,
        );
        return;
      }
      if (fundedNow < target) {
        const shortfall = target - fundedNow;
        setError(
          `This period is under-funded: ${formatAmount(fundedNow)} funded but ${formatAmount(target)} planned. Fund ${formatAmount(shortfall)} more first`,
        );
        addLog(
          `Not paid: funded ${formatAmount(fundedNow)} < planned ${formatAmount(target)} — fund ${formatAmount(shortfall)} more`,
          true,
        );
        return;
      }
      addLog(`Building ZK proof issued == planned (${formatAmount(target)})…`);
      const txHash = await proveFullyPaid(employer.contract, employer.address, company, BigInt(selected.epoch), target);
      addLog(`✓ PROVED fully paid for epoch ${selected.epoch} · tx ${shortAddress(txHash, 8)} — zero amounts revealed`);
      recordTx('prove', `Prove fully paid · epoch ${selected.epoch}`, txHash);
      showToast('Proved fully paid ✓');
      setProvedEpochs((p) => {
        const next = { ...p, [periodKey]: true };
        try { localStorage.setItem(PROVED_KEY, JSON.stringify(next)); } catch {}
        return next;
      });
      setTimeout(() => refreshPayroll(selected), 4000);
    } catch (err) {
      if (isChunkLoadError(err) && recoverFromChunkLoadError()) return;
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      addLog(`Not paid: ${msg}`, true);
      setProvedEpochs((p) => {
        const next = { ...p, [periodKey]: false };
        try { localStorage.setItem(PROVED_KEY, JSON.stringify(next)); } catch {}
        return next;
      });
    } finally {
      setBusy('');
    }
  }, [employer, selected, refreshPayroll, periodKey, plannedTotals]);

  const copyText = useCallback(async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      addLog(`${label} copied to clipboard`);
    } catch {
      addLog('Clipboard unavailable', true);
    }
  }, []);

  // Detect a fresh deploy while the tab is open and offer a refresh, so lazy
  // chunks never go missing mid-action.
  useEffect(() => {
    if (!connected) return;
    let stop = false;
    const check = async () => {
      const mine = currentBundleSrc()?.split('/').pop();
      if (!mine) return; // dev server: no hashed bundles
      const latest = await fetchLatestBundleSrc();
      if (!stop && latest && latest !== mine) setOutdated(true);
    };
    const first = setTimeout(check, 8000);
    const id = setInterval(check, 90000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stop = true;
      clearTimeout(first);
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [connected]);

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
        <div className="top-right">
          <div className="status">
            <span className="pulse" />
            Aztec testnet · live
          </div>
          {connected && (
            <button className="icon-btn disconnect" onClick={handleDisconnect}>
              Disconnect
            </button>
          )}
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      {outdated && (
        <div className="update-banner">
          <span>SalAZy was updated — refresh to load the latest version</span>
          <button className="btn small" onClick={() => window.location.reload()}>
            Refresh
          </button>
        </div>
      )}

      {!connected && !connecting && !status && (
        <section className="hero">
          <div className="orb orb-a" />
          <div className="orb orb-b" />
          <p className="eyebrow">PRIVATE PAYROLL · ZERO-KNOWLEDGE</p>
          <h2>
            Your payroll is nobody's business.
            <br />
            <em>Private</em> to everyone else.
          </h2>
          <p className="lead">
            Payroll with total privacy. No one sees who you pay, what salary,
            or when. Every salary is encrypted to the employee's keypair, and
            a ZK proof confirms everyone got paid without revealing a number.
          </p>
          <div className="features">
            <div className="feature">
              <span className="dot cyan" />
              Nobody sees who paid what
            </div>
            <div className="feature">
              <span className="dot magenta" />
              Your salary stays in privacy mode
            </div>
            <div className="feature">
              <span className="dot violet" />
              Prove payroll ran, zero amounts leaked
            </div>
          </div>
          <button className="btn primary big" onClick={handleConnect} disabled={connecting}>
            Open SalAZy
          </button>
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
                      <div
                        key={b.id}
                        className={`business-row${b.id === selectedId ? ' active' : ''}`}
                      >
                        {editingBusinessId === b.id ? (
                          <div className="edit-inline">
                            <input
                              value={editingBusinessName}
                              onChange={(e) => setEditingBusinessName(e.target.value)}
                              autoFocus
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') saveEditBusiness();
                                if (e.key === 'Escape') setEditingBusinessId(null);
                              }}
                            />
                            <button className="icon-btn ok" onClick={saveEditBusiness}>✓</button>
                            <button className="icon-btn" onClick={() => setEditingBusinessId(null)}>✕</button>
                          </div>
                        ) : (
                          <>
                            <button
                              className="business-main"
                              onClick={() => setSelectedId(b.id)}
                            >
                              <span className="bname">{b.name}</span>
                              <span className="bcount">{b.employees.length} emp</span>
                            </button>
                            <button
                              className="icon-btn edit"
                              title="Rename business"
                              onClick={() => startEditBusiness(b.id)}
                            >
                              ✎
                            </button>
                          </>
                        )}
                      </div>
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
                  </div>
                </div>

                <details className="card tx-history">
                  <summary>Transaction history ({txHistory.length})</summary>
                  <div className="tx-list">
                    {txHistory.length === 0 && (
                      <p className="muted">No transactions yet. Fund, pay, or prove to see them here.</p>
                    )}
                    {txHistory.map((r) => (
                      <div className="tx-row" key={r.id}>
                        <span className={`tx-badge ${r.action}`}>
                          {r.action === 'fund' ? 'F' : r.action === 'pay' ? 'P' : '✓'}
                        </span>
                        <span className="tx-label">{r.label}</span>
                        <span
                          className="tx-hash"
                          title={`${r.hash} · ${r.time}`}
                          onClick={() => copyText(r.hash, 'Tx hash')}
                        >
                          {shortAddress(r.hash, 8)}
                        </span>
                      </div>
                    ))}
                  </div>
                </details>

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
                          ) : alreadyPaid ? (
                            <div className="chip ok-chip">Paid ✓</div>
                          ) : (
                            <div className="chip warn-chip">Partial</div>
                          )}
                          {payroll.funded > payroll.issued && (
                            <div
                              className="chip remain-chip"
                              title="Offered to you when you start the next period"
                            >
                              <span className="chip-lbl">Remaining</span>
                              <span className="chip-val">
                                {formatAmount(payroll.funded - payroll.issued)}
                              </span>
                            </div>
                          )}
                        </div>
                      )}
                      {breakdownParts.length > 0 && (
                        <p className="fund-break">Pool: {breakdownParts.join(' · ')}</p>
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
                        {selected.employees.map((e) =>
                          editingEmployeeId === e.id ? (
                            <div className="emp-row edit-row" key={e.id}>
                              <input
                                className="emp-edit-name"
                                value={editingEmployeeForm.name}
                                onChange={(ev) =>
                                  setEditingEmployeeForm({ ...editingEmployeeForm, name: ev.target.value })
                                }
                                placeholder="Name"
                                autoFocus
                              />
                              <input
                                className="emp-edit-addr"
                                value={editingEmployeeForm.address}
                                onChange={(ev) =>
                                  setEditingEmployeeForm({ ...editingEmployeeForm, address: ev.target.value })
                                }
                                placeholder="Wallet (Aztec address)"
                                spellCheck={false}
                              />
                              <input
                                className="emp-edit-salary"
                                value={editingEmployeeForm.salary}
                                onChange={(ev) =>
                                  setEditingEmployeeForm({ ...editingEmployeeForm, salary: ev.target.value })
                                }
                                placeholder="Salary (1200.00)"
                              />
                              <input
                                className="emp-edit-role"
                                value={editingEmployeeForm.role}
                                onChange={(ev) =>
                                  setEditingEmployeeForm({ ...editingEmployeeForm, role: ev.target.value })
                                }
                                placeholder="Role"
                              />
                              <span className="emp-actions">
                                <button
                                  className="icon-btn ok"
                                  onClick={saveEditEmployee}
                                  title="Save"
                                >
                                  ✓
                                </button>
                                <button
                                  className="icon-btn"
                                  onClick={() => setEditingEmployeeId(null)}
                                  title="Cancel"
                                >
                                  ✕
                                </button>
                              </span>
                            </div>
                          ) : (
                            <div className="emp-row" key={e.id}>
                              <span className="emp-name">{e.name}</span>
                              <code className="emp-addr">{shortAddress(e.address, 8)}</code>
                              <span>{e.salary || '—'}</span>
                              <span>{e.role || '—'}</span>
                              <span className="emp-actions">
                                <button
                                  className="icon-btn edit"
                                  title="Edit employee"
                                  onClick={() => startEditEmployee(e.id)}
                                >
                                  ✎
                                </button>
                                <button className="icon-btn danger" onClick={() => removeEmployee(e.id)}>
                                  ✕
                                </button>
                              </span>
                            </div>
                          ),
                        )}
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
                      <div className="card-title head-row">
                        <span>Payroll · epoch {selected.epoch}</span>
                        <button
                          className="btn small"
                          onClick={handleNextPeriod}
                          disabled={busy !== '' || !isProved}
                          title={
                            isProved
                              ? 'Start the next pay period'
                              : 'Prove this period fully paid first'
                          }
                        >
                          {isProved ? 'Next period ›' : '🔒 Next period ›'}
                        </button>
                      </div>
                      <p className="muted">
                        Fund the period, then pay everyone with one click. Each
                        salary is a private encrypted note; amounts stay hidden.
                        Unspent funding waits for you in the next period.
                      </p>
                      {showCarryOver && (
                        <div className="pay-note carry">
                          <span className="pay-note-dot" />
                          <span>
                            Period {selected.epoch - 1} ended with{' '}
                            {formatAmount(prevEpochLeftover)} unspent
                          </span>
                          <button
                            className="btn small"
                            disabled={busy !== ''}
                            onClick={handleCarryOver}
                            title="Move it into this period as funding"
                          >
                            {busy === 'carry'
                              ? 'Moving…'
                              : `Move ${formatAmount(prevEpochLeftover)} here`}
                          </button>
                        </div>
                      )}
                      <div className="payroll-actions">
                        <div className="row grow">
                          {fundNeeded > 0n ? (
                            <button
                              className="btn primary grow"
                              onClick={handleFund}
                              disabled={busy !== ''}
                              title={`Funds exactly the shortfall: ${formatAmount(salaryTotal)} salaries − already funded`}
                            >
                              {busy === 'fund'
                                ? 'Funding…'
                                : `Fund ${formatAmount(fundNeeded)} · exact`}
                            </button>
                          ) : (
                            <div className="pay-note ok">
                              <span className="pay-note-dot" />
                              <span>Fully funded for this period ✓</span>
                            </div>
                          )}
                        </div>
                        <button
                          className="btn primary"
                          onClick={handlePayEveryone}
                          disabled={busy === 'pay' || !canPay || alreadyPaid}
                          title={
                            alreadyPaid
                              ? 'Everyone was already paid this period'
                              : payrollShortfall !== null
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
                            : alreadyPaid
                              ? 'Already paid ✓'
                              : payrollShortfall !== null
                                ? 'Fund required first'
                                : 'Pay everyone'}
                        </button>
                        {payrollShortfall !== null && (
                          <div className="pay-note">
                            <span className="pay-note-dot" />
                            {formatAmount(currentPayroll!.funded)} funded of{' '}
                            {formatAmount(salaryTotal)} required.{' '}
                            <strong>{formatAmount(payrollShortfall)}</strong> more to unlock
                            payment — the Fund button covers exactly this
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
                        {alreadyPaid && (
                          <div className="pay-note ok">
                            <span className="pay-note-dot" />
                            Everyone paid ✓ — ready to prove fully paid
                          </div>
                        )}
                        <button
                          className="btn outline"
                          onClick={handleProve}
                          disabled={busy !== '' || isProved}
                          title={
                            isProved
                              ? 'This period is proved fully paid ✓'
                              : 'Check this period: proves fully paid, or fails with not paid'
                          }
                        >
                          {busy === 'prove'
                            ? 'Proving…'
                            : isProved
                              ? 'Proved fully paid ✓'
                              : 'Prove fully paid'}
                        </button>
                        {isProved && (
                          <div className="pay-note ok">
                            <span className="pay-note-dot" />
                            ZK proof passed ✓ — you can start the next period
                          </div>
                        )}
                      </div>
                    </div>
                  </>
                )}

                <details className="card epoch-history" open={epochHistory.length > 0}>
                  <summary>Period history ({epochHistory.length})</summary>
                  {epochHistory.length === 0 ? (
                    <p className="muted">No periods yet. Fund and run your first payroll.</p>
                  ) : (
                    <div className="epoch-list">
                      {epochHistory.map((rec) => {
                        const status = rec.issued === 0n && rec.funded === 0n
                          ? 'not-started'
                          : rec.proved
                            ? 'proved'
                            : rec.issued > 0n
                              ? 'paid'
                              : 'funded';
                        const label =
                          status === 'proved'
                            ? 'Proved ✓'
                            : status === 'paid'
                              ? 'Paid'
                              : status === 'funded'
                                ? 'Funded'
                                : 'Not started';
                        return (
                          <div className="epoch-row" key={rec.epoch}>
                            <span className={`epoch-badge ${status}`}>
                              {rec.epoch}
                            </span>
                            <span className="epoch-main">
                              <span className="epoch-title">
                                Period #{rec.epoch}
                                {rec.epoch === selected?.epoch ? ' · current' : ''}
                              </span>
                              <span className="epoch-meta">
                                issued {formatAmount(rec.issued)} · funded{' '}
                                {formatAmount(rec.funded)}
                              </span>
                            </span>
                            <span className={`epoch-status ${status}`}>{label}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </details>
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
                        Once you pay a salary to your own address, it appears here,
                        encrypted to your keypair only.
                      </div>
                    </div>
                  ) : (
                    <div className="pc-list">
                      {paychecks.map((p, i) => (
                        <div className="pc-row" key={i}>
                          <div>
                            <div className="pc-company">{companyNameFor(businesses, p)}</div>
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
                    Salaries land here the moment payroll runs; nothing to
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
