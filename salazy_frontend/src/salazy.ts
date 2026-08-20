import { AztecAddress } from '@aztec/aztec.js/addresses';
import { Fr } from '@aztec/aztec.js/fields';
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import type { Wallet } from '@aztec/aztec.js/wallet';
// @ts-ignore - generated artifact
import { SalAZyContract, SalAZyContractArtifact } from './generated/SalAZy';
import { createSponsoredFeePayment } from './fees';
import { getNodeUrl, SALAZY_CONTRACT_ADDRESS } from './config';

export const MAX_EMPLOYEES_PER_PAYRUN = 8;

export interface EmployeeInput {
  address: AztecAddress;
  amount: bigint;
  role: Fr;
}

export interface SalaryNote {
  company: string;
  epoch: string;
  amount: bigint;
  role: string;
}

export function encodeField(text: string): Fr {
  const bytes = new TextEncoder().encode(text).slice(0, 31);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return new Fr(n);
}

export function decodeField(value: Fr | bigint): string {
  let v = BigInt(value.toString());
  const chunk = new Array<number>(31).fill(0);
  for (let j = 31 - 1; j >= 0; j--) {
    chunk[j] = Number(v & 0xffn);
    v >>= 8n;
  }
  const first = chunk.findIndex((b) => b !== 0);
  if (first === -1) return '';
  return new TextDecoder().decode(new Uint8Array(chunk.slice(first)));
}

export async function attachToSalAZy(
  wallet: Wallet,
  contractAddress: AztecAddress = AztecAddress.fromStringUnsafe(SALAZY_CONTRACT_ADDRESS),
) {
  const node = createAztecNodeClient(getNodeUrl());
  const instance = await node.getContract(contractAddress);
  if (!instance) {
    throw new Error(`Contract not found onchain at ${contractAddress}`);
  }
  await wallet.registerContract(instance, SalAZyContractArtifact);
  return SalAZyContract.at(contractAddress, wallet);
}

async function feeMethod() {
  return createSponsoredFeePayment();
}

export async function fund(
  contract: SalAZyContract,
  from: AztecAddress,
  company: Fr,
  epoch: bigint,
  amount: bigint,
): Promise<string> {
  const paymentMethod = await feeMethod();
  const result = await contract.methods
    .fund(company, epoch, amount)
    .send({ from, fee: { paymentMethod } });
  return result.receipt.txHash.toString();
}

export async function issueSalary(
  contract: SalAZyContract,
  from: AztecAddress,
  company: Fr,
  epoch: bigint,
  employee: AztecAddress,
  amount: bigint,
  role: Fr,
): Promise<string> {
  const paymentMethod = await feeMethod();
  const result = await contract.methods
    .issue_salary(company, epoch, employee, amount, role)
    .send({ from, fee: { paymentMethod } });
  return result.receipt.txHash.toString();
}

export async function issueSalaries(
  contract: SalAZyContract,
  from: AztecAddress,
  company: Fr,
  epoch: bigint,
  employees: EmployeeInput[],
): Promise<string> {
  const padded: EmployeeInput[] = employees.slice(0, MAX_EMPLOYEES_PER_PAYRUN);
  while (padded.length < MAX_EMPLOYEES_PER_PAYRUN) {
    padded.push({ address: AztecAddress.ZERO, amount: 0n, role: new Fr(0n) });
  }
  const paymentMethod = await feeMethod();
  const result = await contract.methods
    .issue_salaries(company, epoch, padded)
    .send({ from, fee: { paymentMethod } });
  return result.receipt.txHash.toString();
}

export async function proveFullyPaid(
  contract: SalAZyContract,
  from: AztecAddress,
  company: Fr,
  epoch: bigint,
  total: bigint,
): Promise<string> {
  const paymentMethod = await feeMethod();
  const result = await contract.methods
    .prove_fully_paid(company, epoch, total)
    .send({ from, fee: { paymentMethod } });
  return result.receipt.txHash.toString();
}

export async function viewFunding(
  contract: SalAZyContract,
  owner: AztecAddress,
  company: Fr,
  epoch: bigint,
): Promise<bigint> {
  const sim = await contract.methods
    .view_funding(owner, company, epoch)
    .simulate({ from: owner });
  return BigInt((sim.result as Fr).toString());
}

export async function viewIssued(
  contract: SalAZyContract,
  owner: AztecAddress,
  company: Fr,
  epoch: bigint,
): Promise<bigint> {
  const sim = await contract.methods
    .view_issued(owner, company, epoch)
    .simulate({ from: owner });
  return BigInt((sim.result as Fr).toString());
}

export async function isFullyPaid(
  contract: SalAZyContract,
  owner: AztecAddress,
  company: Fr,
  epoch: bigint,
): Promise<boolean> {
  const sim = await contract.methods
    .is_fully_paid(owner, company, epoch)
    .simulate({ from: owner });
  return sim.result as boolean;
}

export async function viewBalanceNotes(
  contract: SalAZyContract,
  owner: AztecAddress,
): Promise<SalaryNote[]> {
  const sim = await contract.methods
    .view_balance_notes(owner)
    .simulate({ from: owner });
  const result = sim.result as {
    len: number;
    storage: { company: Fr; epoch: Fr; amount: Fr; role: Fr }[];
  };
  if (!result || !result.storage) return [];
  return result.storage.slice(0, Number(result.len)).map((n) => ({
    company: decodeField(n.company),
    epoch: BigInt(n.epoch.toString()).toString(),
    amount: BigInt(n.amount.toString()),
    role: decodeField(n.role),
  }));
}

export async function viewBalance(
  contract: SalAZyContract,
  owner: AztecAddress,
): Promise<bigint> {
  const sim = await contract.methods
    .view_balance(owner)
    .simulate({ from: owner });
  return BigInt((sim.result as Fr).toString());
}
