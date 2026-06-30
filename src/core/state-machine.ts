import { InvalidNonceError } from '../errors.js';
import type { NonceStatus, PersistedNonceState } from '../types.js';

/**
 * Pure nonce state machine. No network, no clocks, no persistence — every
 * function takes a {@link PersistedNonceState} and returns a *new* state object
 * (the input is never mutated), so the whole thing is trivially unit-testable
 * and the manager can snapshot/restore freely.
 *
 * Allocation order: released nonces (lowest first) are always reused before the
 * `next` high-water mark, so a failed broadcast never leaves a permanent gap.
 */

/** Seed state from the chain's `latest` and `pending` transaction counts. */
export function init(latest: number, pending: number): PersistedNonceState {
  assertCount('latest', latest);
  assertCount('pending', pending);
  return {
    confirmed: latest,
    // `pending` includes queued txs; treat them as already in flight so we
    // never hand out a nonce the mempool is already using.
    next: Math.max(latest, pending),
    released: [],
  };
}

/** The nonce that the next {@link allocate} would return — no mutation. */
export function peek(state: PersistedNonceState): number {
  return state.released.length > 0 ? (state.released[0] as number) : state.next;
}

/** Consume the next nonce: a released one (lowest) if any, else the watermark. */
export function allocate(state: PersistedNonceState): {
  state: PersistedNonceState;
  nonce: number;
} {
  if (state.released.length > 0) {
    const [nonce, ...rest] = state.released;
    return { state: { ...state, released: rest }, nonce: nonce as number };
  }
  return {
    state: { ...state, next: state.next + 1 },
    nonce: state.next,
  };
}

/**
 * Return a previously allocated, unused nonce. If it sits at the watermark the
 * watermark shrinks (and pulls any contiguous released nonces down with it),
 * keeping state compact; otherwise it joins the released set for reuse.
 */
export function release(state: PersistedNonceState, nonce: number): PersistedNonceState {
  assertCount('nonce', nonce);
  if (nonce < state.confirmed) {
    // Already mined — cannot be un-confirmed. No-op keeps release idempotent
    // against a late confirm.
    return state;
  }
  if (nonce >= state.next) {
    throw new InvalidNonceError(
      `cannot release nonce ${nonce}: it was never allocated (next is ${state.next})`,
    );
  }
  if (state.released.includes(nonce)) {
    return state; // idempotent
  }

  // Releasing the top of the range: shrink the watermark and absorb any
  // now-trailing released nonces so we don't accumulate fragmentation.
  if (nonce === state.next - 1) {
    const released = new Set(state.released);
    let next = nonce;
    while (next > state.confirmed && released.has(next - 1)) {
      released.delete(next - 1);
      next -= 1;
    }
    return { ...state, next, released: sorted(released) };
  }

  return { ...state, released: sorted(new Set(state.released).add(nonce)) };
}

/**
 * Mark `nonce` confirmed on chain. On EVM a transaction with nonce *n* can only
 * be mined once every nonce `< n` is mined, so observing *n* confirmed implies
 * the confirmed pointer is at least `n + 1`. We therefore advance to `n + 1`
 * (never backwards) and drop any released/in-range bookkeeping below it.
 */
export function confirm(state: PersistedNonceState, nonce: number): PersistedNonceState {
  assertCount('nonce', nonce);
  const advanced = nonce + 1;
  if (advanced <= state.confirmed) {
    return state; // stale or duplicate confirm — idempotent
  }
  return normalizeToConfirmed(state, advanced);
}

/**
 * Reconcile against the chain's authoritative counts. Recovers from drift in
 * either direction:
 *
 * - chain ahead (`latest > confirmed`): txs confirmed we didn't track, or a
 *   `nonce too low` recovery — advance `confirmed`.
 * - chain behind (`latest < confirmed`): a reorg regressed the confirmed nonce
 *   — lower `confirmed` but keep `next` so still-pending allocations are not
 *   reissued as fresh, preserving allocation consistency.
 * - `pending` raises `next` to cover queued txs we didn't allocate ourselves.
 */
export function reconcile(
  state: PersistedNonceState,
  chain: { latest: number; pending: number },
): PersistedNonceState {
  assertCount('latest', chain.latest);
  assertCount('pending', chain.pending);

  const next = Math.max(state.next, chain.pending, chain.latest);

  if (chain.latest === state.confirmed) {
    return { ...state, next };
  }
  // normalizeToConfirmed handles both advance and reorg-regression of confirmed.
  return normalizeToConfirmed({ ...state, next }, chain.latest);
}

/** Derive the public `{ confirmed, allocated, inFlight }` view. */
export function status(state: PersistedNonceState): NonceStatus {
  return {
    confirmed: state.confirmed,
    allocated: state.next,
    inFlight: state.next - state.confirmed - state.released.length,
  };
}

// --- internals -------------------------------------------------------------

/**
 * Set the confirmed pointer (up or down) and re-establish invariants: `next`
 * never below `confirmed`, and `released` trimmed to the in-range window.
 */
function normalizeToConfirmed(
  state: PersistedNonceState,
  confirmed: number,
): PersistedNonceState {
  const next = Math.max(state.next, confirmed);
  const released = state.released.filter((n) => n >= confirmed && n < next);
  return { confirmed, next, released };
}

function sorted(set: Set<number>): number[] {
  return [...set].sort((a, b) => a - b);
}

function assertCount(label: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new InvalidNonceError(`${label} must be a non-negative integer, got ${value}`);
  }
}
