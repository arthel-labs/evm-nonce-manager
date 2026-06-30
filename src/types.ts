import type { Address, Hex, PublicClient } from 'viem';

/**
 * Serializable per-account nonce state. This is the entire source of truth a
 * {@link NonceStore} must persist; everything else is derived.
 *
 * - `confirmed` — the next nonce the chain expects for a brand-new confirmed
 *   transaction (equivalently, `getTransactionCount(..., 'latest')`). All nonces
 *   `< confirmed` are mined.
 * - `next` — the high-water mark: the next *fresh* nonce to hand out when there
 *   are no released nonces to reuse.
 * - `released` — nonces in the half-open range `[confirmed, next)` that were
 *   allocated but handed back (failed broadcast); reused before `next`. Kept
 *   sorted ascending with no duplicates.
 *
 * Invariants: `confirmed <= next`, every entry of `released` is in
 * `[confirmed, next)`, and `released` is sorted and unique.
 */
export interface PersistedNonceState {
  confirmed: number;
  next: number;
  released: number[];
}

/** A snapshot of an account's nonce situation. */
export interface NonceStatus {
  /** Next nonce the chain expects for a new confirmed tx. */
  confirmed: number;
  /** High-water mark — the next fresh nonce that would be allocated. */
  allocated: number;
  /** Nonces handed out but neither confirmed nor released. */
  inFlight: number;
}

/** Composite key for a `(chainId, account)` pair. Always lower-cased address. */
export type NonceStateKey = `${number}:${string}`;

/**
 * Pluggable persistence boundary. Ship an in-memory implementation by default;
 * a Redis/Postgres store can be dropped in without touching core logic.
 *
 * Implementations only store and retrieve {@link PersistedNonceState} blobs by
 * key — they hold no logic. Concurrency safety is the manager's responsibility
 * (per-account serialization), so a store does not need its own locking.
 */
export interface NonceStore {
  get(key: NonceStateKey): Promise<PersistedNonceState | undefined>;
  set(key: NonceStateKey, state: PersistedNonceState): Promise<void>;
}

/** EIP-1559 dynamic fee fields. */
export interface Eip1559Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** Legacy (pre-1559) fee field. */
export interface LegacyFees {
  gasPrice: bigint;
}

/** Either fee market's fee fields. */
export type Fees = Eip1559Fees | LegacyFees;

/** Options controlling how much to bump fees when replacing/cancelling. */
export interface BumpOptions {
  /**
   * Percentage to raise each fee field over the original, e.g. `10` for +10%.
   * Floored at the network's minimum replacement bump (10%). Defaults to the
   * manager's `defaultFeeBumpPercent`.
   */
  feeBumpPercent?: number;
}

/** Options for {@link NonceManager.buildReplacement}. */
export interface ReplacementInput {
  to: Address;
  value?: bigint;
  data?: Hex;
  gas?: bigint;
  /**
   * The stuck transaction's original fees. When provided, the bump is computed
   * relative to these (guaranteeing the replacement out-bids it). When omitted,
   * the manager fetches a current suggestion from the chain and bumps that.
   */
  fees?: Fees;
}

/** Options for {@link NonceManager.buildCancellation}. */
export interface CancellationOptions extends BumpOptions {
  /** Original stuck-tx fees to out-bid. Fetched from chain if omitted. */
  fees?: Fees;
  /** Gas limit for the 0-value self-send. Defaults to 21000. */
  gas?: bigint;
}

/**
 * A ready-to-sign replacement/cancellation request. Shaped to be passed
 * straight into `walletClient.sendTransaction(...)`.
 */
export type NonceTransactionRequest = {
  from: Address;
  to: Address;
  value: bigint;
  data: Hex;
  nonce: number;
  gas: bigint;
} & (Eip1559Fees | LegacyFees);

export interface NonceManagerOptions {
  /** A Viem `PublicClient`. Its `chain.id` keys all per-account state. */
  client: PublicClient;
  /** Persistence backend. Defaults to {@link InMemoryNonceStore}. */
  store?: NonceStore;
  /** Reconcile each account against the chain on first use. Default: `true`. */
  reconcileOnStart?: boolean;
  /**
   * If set, every account is periodically reconciled on this interval (ms).
   * Off by default. Remember to call {@link NonceManager.stop} on shutdown.
   */
  reconcileIntervalMs?: number;
  /**
   * Block tag used to seed `next` on initialization. `'pending'` (default)
   * counts queued txs as in-flight so the manager won't reuse their nonces.
   */
  initBlockTag?: 'pending' | 'latest';
  /** Default fee bump percentage for replacements/cancellations. Default: 10. */
  defaultFeeBumpPercent?: number;
}

export interface NonceManager {
  /**
   * The headline primitive. Allocates a nonce, runs `fn(nonce)`, and — if `fn`
   * throws (e.g. broadcast fails) — releases the nonce so the next allocation
   * reuses it. No permanent gap from a failed broadcast.
   */
  withNonce<T>(account: Address, fn: (nonce: number) => Promise<T>): Promise<T>;

  /** Peek the next nonce that would be allocated, without consuming it. */
  peek(account: Address): Promise<number>;
  /** Consume and return the next nonce. */
  allocate(account: Address): Promise<number>;
  /** Return a previously allocated, unused nonce so it can be reused. */
  release(account: Address, nonce: number): Promise<void>;
  /** Mark a nonce confirmed on chain, advancing the confirmed pointer. */
  confirm(account: Address, nonce: number): Promise<void>;
  /** Reconcile internal state with the chain; recovers from drift. */
  resync(account: Address): Promise<NonceStatus>;
  /** Current `{ confirmed, allocated, inFlight }` snapshot. */
  status(account: Address): Promise<NonceStatus>;

  /** Build a same-nonce, fee-bumped replacement for a stuck transaction. */
  buildReplacement(
    account: Address,
    nonce: number,
    original: ReplacementInput,
    opts?: BumpOptions,
  ): Promise<NonceTransactionRequest>;
  /** Build a same-nonce, 0-value self-send to cancel a stuck transaction. */
  buildCancellation(
    account: Address,
    nonce: number,
    opts?: CancellationOptions,
  ): Promise<NonceTransactionRequest>;

  /** Stop the background reconcile interval, if one was configured. */
  stop(): void;
}
