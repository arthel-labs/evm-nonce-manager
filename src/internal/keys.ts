import type { Address } from 'viem';
import type { NonceStateKey } from '../types.js';

/**
 * Build the `(chainId, account)` store key. The address is lower-cased so the
 * same account is never split across two keys by checksum casing.
 */
export function makeKey(chainId: number, account: Address): NonceStateKey {
  return `${chainId}:${account.toLowerCase()}`;
}
