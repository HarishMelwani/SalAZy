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

const WALLET_STORE_NAME = 'privazy-wallet';
const PXE_STORE_NAME = 'privazy-pxe';

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
 * Create a hardened embedded wallet for the browser.
 *
 * Unlike the bare `EmbeddedWallet.create(url)`, this:
 * - uses IndexedDB-backed stores (fixed names, persistent across reloads)
 *   instead of sqlite-opfs WASM workers, which can hang indefinitely in some
 *   Chromium embeds / after COEP;
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
  const log = createLogger('privazy');
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
    pxeConfig: { proverEnabled },
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

/**
 * Recover the persistent account, or mint a fresh one on first run.
 *
 * The account address is derived purely from random keys (no on-chain
 * deployment). Keys are stored in the persistent wallet DB, so the same
 * identity and inbox survive reloads.
 */
export async function createSessionAccount(
  wallet: EmbeddedWallet,
): Promise<CreateSessionAccountResult> {
  const existing = await wallet.getAccounts();
  if (existing.length > 0) {
    return { address: existing[0].item };
  }
  const account = await wallet.createSchnorrInitializerlessAccount(
    Fr.random(),
    Fr.random(),
    Fq.random(),
  );
  return { address: account.address };
}
