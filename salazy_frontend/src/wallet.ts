import { EmbeddedWallet } from '@aztec/wallets/embedded';
import { Fr, Fq } from '@aztec/aztec.js/fields';
import { createAztecNodeClient } from '@aztec/aztec.js/node';
import type { AztecAsyncKVStore } from '@aztec/kv-store';
import { AztecIndexedDBStore } from '@aztec/kv-store/deprecated/indexeddb';
import { createLogger } from '@aztec/foundation/log';
import type { AztecAddress } from '@aztec/aztec.js/addresses';
import { STANDARD_HANDSHAKE_REGISTRY_ADDRESS } from '@aztec/standard-contracts/handshake-registry/constants';
import { STANDARD_AUTH_REGISTRY_ADDRESS } from '@aztec/standard-contracts/auth-registry/constants';
import { getNodeUrl } from './config';

const WALLET_STORE_NAME = 'salazy-wallet';
const PXE_STORE_NAME = 'salazy-pxe';

export type ProgressFn = (text: string) => void;

/** iPhone / iPad (including iPadOS that reports as Macintosh). */
export function isIosBrowser() {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  if (/iPad|iPhone|iPod/.test(ua)) return true;
  return (
    navigator.platform === 'MacIntel' && (navigator.maxTouchPoints || 0) > 1
  );
}

/** bb.js options for the PXE prover on memory-constrained Safari/iOS. */
export function bbProverOptionsForBrowser() {
  if (!isIosBrowser()) return {};
  return {
    threads: 1,
    srsSize: 2 ** 18,
    memory: { initial: 37, maximum: 2 ** 14 },
  };
}

export interface CreateWalletOptions {
  proverEnabled?: boolean;
  onProgress?: ProgressFn;
}

/**
 * Whitelist ONLY the canonical registry contracts for cross-contract utility
 * calls made during private execution (handshake discovery / SingleUseClaim),
 * never arbitrary targets.
 */
const authorizeUtilityCall = async (request: {
  target: AztecAddress;
  functionName?: string;
}) => {
  if (
    request.target.equals(STANDARD_HANDSHAKE_REGISTRY_ADDRESS) ||
    request.target.equals(STANDARD_AUTH_REGISTRY_ADDRESS)
  ) {
    return { authorized: true };
  }
  return {
    authorized: false,
    reason: `Unauthorized utility call to ${request.functionName ?? ''} on ${String(request.target)}`,
  };
};

/**
 * Create a persistent embedded wallet for the browser.
 *
 * Unlike an ephemeral wallet, this:
 * - uses IndexedDB-backed stores with FIXED names (survive reloads, so the
 *   same identity is recovered every session);
 * - tunes the proving backend for memory-constrained mobile browsers;
 * - whitelists ONLY the canonical registry contracts for cross-contract
 *   utility calls made during private execution (handshake discovery /
 *   SingleUseClaim), never arbitrary targets.
 */
export async function createWallet({
  proverEnabled = false,
  onProgress,
}: CreateWalletOptions = {}) {
  onProgress?.('Opening local PXE (IndexedDB)...');
  const node = createAztecNodeClient(getNodeUrl());
  const log = createLogger('salazy-wallet');
  const pxeStore: AztecAsyncKVStore = await AztecIndexedDBStore.open(
    log.createChild('pxe'),
    PXE_STORE_NAME,
    false,
  );
  const walletStore: AztecAsyncKVStore = await AztecIndexedDBStore.open(
    log.createChild('wallet'),
    WALLET_STORE_NAME,
    false,
  );
  const bbOptions = bbProverOptionsForBrowser();
  onProgress?.(
    bbOptions && bbOptions.threads === 1
      ? 'Starting wallet (iPhone: single-thread prover)...'
      : 'Starting wallet...',
  );
  return EmbeddedWallet.create(node, {
    pxeConfig: {
      proverEnabled,
      // CRITICAL: the default batch size (50) makes a fresh wallet's first
      // chain scan fire ~1000+ sequential RPC round-trips = multi-minute
      // hangs. Large batches keep the first sync to a handful of requests.
      l2BlockBatchSize: 1000,
      syncChainTip: 'proposed',
    },
    pxeOptions: {
      store: pxeStore,
      proverOrOptions: bbOptions,
      hooks: {
        authorizeUtilityCall,
      },
    },
    walletDb: { store: walletStore },
  });
}

export interface CreateSessionAccountResult {
  address: import('@aztec/aztec.js/addresses').AztecAddress;
}

/** Remembers which identity to resume when several exist in the wallet DB. */
export const ACTIVE_ACCOUNT_KEY = 'salazy.activeAccount.v1';

function readActiveAccount(): string | null {
  try {
    return localStorage.getItem(ACTIVE_ACCOUNT_KEY);
  } catch {
    return null;
  }
}

export function rememberActiveAccount(address: AztecAddress) {
  try {
    localStorage.setItem(ACTIVE_ACCOUNT_KEY, address.toString());
  } catch {
    /* storage unavailable — identity still lives in IndexedDB */
  }
}

/**
 * Recover the persistent account, or mint a fresh one on first run.
 *
 * The account address is derived purely from random keys (no on-chain
 * deployment). Keys are stored in the persistent wallet DB, so the same
 * identity and inbox survive reloads. The wallet is only ever lost if the
 * browser's site data (IndexedDB) is cleared.
 */
export async function createSessionAccount(
  wallet: EmbeddedWallet,
): Promise<CreateSessionAccountResult> {
  const existing = await wallet.getAccounts();
  if (existing.length > 0) {
    // Resume the LAST-ACTIVE identity (localStorage) when several exist.
    const wanted = readActiveAccount();
    const match = wanted
      ? existing.find((a) => a.item.toString() === wanted)
      : undefined;
    const address = (match ?? existing[0]).item;
    rememberActiveAccount(address);
    return { address };
  }
  const account = await wallet.createSchnorrInitializerlessAccount(
    Fr.random(),
    Fr.random(),
    Fq.random(),
  );
  rememberActiveAccount(account.address);
  return { address: account.address };
}

// ---------------------------------------------------------------------------
// Backup / restore — a portable JSON file of the account's secret keys.
// Same keys always derive the same address; re-importing into a wallet that
// already holds them is a harmless no-op.
// ---------------------------------------------------------------------------

export interface WalletBackup {
  format: 'salazy-backup';
  version: 1;
  address: string;
  type: string;
  /** Hex-string Fr. */
  secretKey: string;
  /** Hex-string Fr. */
  salt: string;
  /** Hex-string signing key ("0x…"). */
  signingKey: string;
}

function bytesToHex(value: unknown): string {
  // retrieveAccount returns signingKey as a Buffer (a Uint8Array subclass).
  const bytes = value as Uint8Array;
  let out = '0x';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

/** Export the account's secret keys as a portable backup object. */
export async function exportAccountBackup(
  wallet: EmbeddedWallet,
  address: AztecAddress,
): Promise<WalletBackup> {
  // walletDB is protected; this escape hatch is the documented way to read
  // back the raw keys for backup purposes.
  const acct = await (
    wallet as unknown as {
      walletDB: {
        retrieveAccount(a: string): Promise<{
          type?: string;
          secretKey?: { toString(): string };
          salt?: { toString(): string };
          signingKey?: unknown;
        }>;
      };
    }
  ).walletDB.retrieveAccount(address.toString());
  if (!acct?.secretKey || !acct?.salt || acct.signingKey == null) {
    throw new Error('Account keys not found in the local wallet');
  }
  return {
    format: 'salazy-backup',
    version: 1,
    address: address.toString(),
    type: String(acct.type ?? ''),
    secretKey: acct.secretKey.toString(),
    salt: acct.salt.toString(),
    signingKey: bytesToHex(acct.signingKey),
  };
}

/** Import a backup file: recreates the identical account in this wallet DB. */
export async function importAccountBackup(
  wallet: EmbeddedWallet,
  backup: WalletBackup,
): Promise<AztecAddress> {
  if (backup?.format !== 'salazy-backup' || backup.version !== 1) {
    throw new Error('Not a SalAZy backup file');
  }
  const secretKey = Fr.fromString(backup.secretKey);
  const salt = Fr.fromString(backup.salt);
  const signingKey = Fq.fromHexString(
    backup.signingKey.startsWith('0x') ? backup.signingKey : `0x${backup.signingKey}`,
  );
  // Same creator that minted the original account → identical address.
  const account = await wallet.createSchnorrInitializerlessAccount(
    secretKey,
    salt,
    signingKey,
  );
  rememberActiveAccount(account.address);
  return account.address;
}
