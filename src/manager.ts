import type { Address } from 'viem';
import { ChainAdapter } from './chain/adapter.js';
import { KeyedMutex } from './core/mutex.js';
import * as sm from './core/state-machine.js';
import { makeKey } from './internal/keys.js';
import {
  buildCancellationRequest,
  buildReplacementRequest,
  effectiveBumpPercent,
} from './replacement.js';
import { InMemoryNonceStore } from './store/memory-store.js';
import type {
  BumpOptions,
  CancellationOptions,
  NonceManager,
  NonceManagerOptions,
  NonceStatus,
  NonceStateKey,
  NonceStore,
  NonceTransactionRequest,
  PersistedNonceState,
  ReplacementInput,
} from './types.js';

const DEFAULT_FEE_BUMP_PERCENT = 10;
const DEFAULT_CANCELLATION_GAS = 21_000n;

/**
 * Create a nonce manager bound to a Viem `PublicClient`. Orchestrates the pure
 * {@link sm state machine}, the {@link ChainAdapter}, the {@link NonceStore},
 * and a per-account {@link KeyedMutex} so allocation is race-free per account
 * and parallel across accounts.
 */
export function createNonceManager(opts: NonceManagerOptions): NonceManager {
  const store: NonceStore = opts.store ?? new InMemoryNonceStore();
  const adapter = new ChainAdapter(opts.client);
  const mutex = new KeyedMutex();

  const reconcileOnStart = opts.reconcileOnStart ?? true;
  const defaultFeeBumpPercent = opts.defaultFeeBumpPercent ?? DEFAULT_FEE_BUMP_PERCENT;

  // Accounts touched at least once, so the interval reconciler knows the set.
  const known = new Map<NonceStateKey, Address>();
  // Keys whose persisted state has already been reconciled this process.
  const started = new Set<NonceStateKey>();
  let chainIdPromise: Promise<number> | undefined;

  function chainId(): Promise<number> {
    return (chainIdPromise ??= adapter.chainId());
  }

  /** Load state, initializing from chain when absent or reconciling on first use. */
  async function load(key: NonceStateKey, account: Address): Promise<PersistedNonceState> {
    const existing = await store.get(key);
    if (!existing) {
      const { latest, pending } = await adapter.getCounts(account);
      // 'pending' (default) treats queued txs as in-flight; 'latest' ignores them.
      const seedPending = (opts.initBlockTag ?? 'pending') === 'pending' ? pending : latest;
      const state = sm.init(latest, seedPending);
      await store.set(key, state);
      started.add(key);
      return state;
    }
    if (reconcileOnStart && !started.has(key)) {
      const counts = await adapter.getCounts(account);
      const state = sm.reconcile(existing, counts);
      if (state !== existing) await store.set(key, state);
      started.add(key);
      return state;
    }
    return existing;
  }

  /**
   * Run `fn` against the account's state under its mutex, persisting only when
   * the state object actually changed (the pure functions return the same
   * reference for no-op reads like `peek`/`status`).
   */
  async function withState<T>(
    account: Address,
    fn: (state: PersistedNonceState) => { state: PersistedNonceState; result: T } | Promise<{ state: PersistedNonceState; result: T }>,
  ): Promise<T> {
    const id = await chainId();
    const key = makeKey(id, account);
    known.set(key, account);
    return mutex.runExclusive(key, async () => {
      const state = await load(key, account);
      const { state: next, result } = await fn(state);
      if (next !== state) await store.set(key, next);
      return result;
    });
  }

  async function resync(account: Address): Promise<NonceStatus> {
    return withState(account, async (state) => {
      const counts = await adapter.getCounts(account);
      const next = sm.reconcile(state, counts);
      return { state: next, result: sm.status(next) };
    });
  }

  async function allocate(account: Address): Promise<number> {
    return withState(account, (state) => {
      const { state: next, nonce } = sm.allocate(state);
      return { state: next, result: nonce };
    });
  }

  async function release(account: Address, nonce: number): Promise<void> {
    return withState(account, (state) => ({ state: sm.release(state, nonce), result: undefined }));
  }

  /** Resolve fees for a replacement/cancellation, fetching from chain if absent. */
  async function resolveFees(input: { fees?: ReplacementInput['fees'] }) {
    return input.fees ?? (await adapter.suggestEip1559Fees());
  }

  const manager: NonceManager = {
    async withNonce<T>(account: Address, fn: (nonce: number) => Promise<T>): Promise<T> {
      const nonce = await allocate(account);
      try {
        return await fn(nonce);
      } catch (err) {
        const classified = adapter.classifyBroadcastError(err, account, nonce, nonce);
        if (classified) {
          // Our view drifted from chain reality (too low / gap). Reconcile so
          // the next call is correct, and surface the typed error.
          await resync(account).catch(() => undefined);
          throw classified;
        }
        // Ordinary failure before the tx took hold: hand the nonce back so the
        // next allocation reuses it — no permanent gap.
        await release(account, nonce).catch(() => undefined);
        throw err;
      }
    },

    async peek(account: Address): Promise<number> {
      return withState(account, (state) => ({ state, result: sm.peek(state) }));
    },

    allocate,
    release,

    async confirm(account: Address, nonce: number): Promise<void> {
      return withState(account, (state) => ({ state: sm.confirm(state, nonce), result: undefined }));
    },

    resync,

    async status(account: Address): Promise<NonceStatus> {
      return withState(account, (state) => ({ state, result: sm.status(state) }));
    },

    async buildReplacement(
      account: Address,
      nonce: number,
      original: ReplacementInput,
      bumpOpts?: BumpOptions,
    ): Promise<NonceTransactionRequest> {
      const fees = await resolveFees(original);
      return buildReplacementRequest({
        from: account,
        to: original.to,
        value: original.value ?? 0n,
        data: original.data ?? '0x',
        gas: original.gas ?? DEFAULT_CANCELLATION_GAS,
        nonce,
        fees,
        bumpPercent: effectiveBumpPercent(bumpOpts?.feeBumpPercent, defaultFeeBumpPercent),
      });
    },

    async buildCancellation(
      account: Address,
      nonce: number,
      cancelOpts?: CancellationOptions,
    ): Promise<NonceTransactionRequest> {
      const fees = await resolveFees(cancelOpts ?? {});
      return buildCancellationRequest({
        from: account,
        gas: cancelOpts?.gas ?? DEFAULT_CANCELLATION_GAS,
        nonce,
        fees,
        bumpPercent: effectiveBumpPercent(cancelOpts?.feeBumpPercent, defaultFeeBumpPercent),
      });
    },

    stop(): void {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };

  // Optional background reconciliation of every account we've seen.
  let timer: ReturnType<typeof setInterval> | undefined;
  if (opts.reconcileIntervalMs && opts.reconcileIntervalMs > 0) {
    timer = setInterval(() => {
      for (const account of known.values()) {
        void resync(account).catch(() => undefined);
      }
    }, opts.reconcileIntervalMs);
    // Don't keep the event loop alive just for reconciliation.
    timer.unref?.();
  }

  return manager;
}
