import type { Address, Hex } from 'viem';
import type { Eip1559Fees, Fees, NonceTransactionRequest } from './types.js';

/**
 * Stuck-transaction helpers: pure fee-bump math and request builders. A node
 * only accepts a replacement (same account + same nonce) if it sufficiently
 * out-bids the pending one — geth's default `priceBump` is **10%**, applied to
 * *both* EIP-1559 fee fields (or to `gasPrice` on legacy chains). These helpers
 * enforce that floor.
 */

/** Minimum bump a node requires to replace a pending tx (geth default). */
export const MIN_REPLACEMENT_BUMP_PERCENT = 10;

/** Resolve the bump percent, never going below the network minimum. */
export function effectiveBumpPercent(requested: number | undefined, fallback: number): number {
  const chosen = requested ?? fallback;
  return Math.max(chosen, MIN_REPLACEMENT_BUMP_PERCENT);
}

/** Distinguish 1559 fees from legacy at runtime. */
export function isEip1559(fees: Fees): fees is Eip1559Fees {
  return 'maxFeePerGas' in fees;
}

/** Raise a single fee field by `percent`, rounding up so it strictly exceeds it. */
export function bumpValue(value: bigint, percent: number): bigint {
  if (value === 0n) return 0n;
  // ceil(value * (100 + percent) / 100)
  const scaled = value * BigInt(100 + percent) + 99n;
  return scaled / 100n;
}

/** Bump every fee field of either fee market by `percent`. */
export function bumpFees(fees: Fees, percent: number): Fees {
  if (isEip1559(fees)) {
    return {
      maxFeePerGas: bumpValue(fees.maxFeePerGas, percent),
      maxPriorityFeePerGas: bumpValue(fees.maxPriorityFeePerGas, percent),
    };
  }
  return { gasPrice: bumpValue(fees.gasPrice, percent) };
}

/** Build a same-nonce replacement that resends the original call with bumped fees. */
export function buildReplacementRequest(params: {
  from: Address;
  to: Address;
  value: bigint;
  data: Hex;
  gas: bigint;
  nonce: number;
  fees: Fees;
  bumpPercent: number;
}): NonceTransactionRequest {
  return {
    from: params.from,
    to: params.to,
    value: params.value,
    data: params.data,
    gas: params.gas,
    nonce: params.nonce,
    ...bumpFees(params.fees, params.bumpPercent),
  };
}

/**
 * Build a cancellation: a 0-value self-send at the same nonce with bumped fees.
 * Mining it evicts the stuck tx and frees everything queued behind it.
 */
export function buildCancellationRequest(params: {
  from: Address;
  gas: bigint;
  nonce: number;
  fees: Fees;
  bumpPercent: number;
}): NonceTransactionRequest {
  return {
    from: params.from,
    to: params.from,
    value: 0n,
    data: '0x',
    gas: params.gas,
    nonce: params.nonce,
    ...bumpFees(params.fees, params.bumpPercent),
  };
}
