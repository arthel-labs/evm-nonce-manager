/**
 * @arthel/evm-nonce-manager
 *
 * Reliable EVM transaction nonce management on top of Viem: race-free
 * allocation under concurrency, gap-free recovery from failed broadcasts,
 * reorg tolerance, and stuck-transaction replacement/cancellation.
 */

export { createNonceManager } from './manager.js';
export { InMemoryNonceStore } from './store/memory-store.js';
export { makeKey } from './internal/keys.js';

export {
  MIN_REPLACEMENT_BUMP_PERCENT,
  bumpFees,
  bumpValue,
  isEip1559,
} from './replacement.js';

export {
  NonceManagerError,
  NonceTooLowError,
  NonceTooHighError,
  InvalidNonceError,
} from './errors.js';

export type {
  NonceManager,
  NonceManagerOptions,
  NonceStatus,
  NonceStore,
  NonceStateKey,
  PersistedNonceState,
  BumpOptions,
  CancellationOptions,
  ReplacementInput,
  NonceTransactionRequest,
  Fees,
  Eip1559Fees,
  LegacyFees,
} from './types.js';
