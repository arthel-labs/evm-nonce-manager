import type { Address, PublicClient } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNonceManager } from '../src/manager.js';
import { InMemoryNonceStore } from '../src/store/memory-store.js';
import { makeKey } from '../src/internal/keys.js';
import { NonceTooLowError } from '../src/errors.js';

const ACCOUNT = '0x0000000000000000000000000000000000000001' as Address;
const ACCOUNT_B = '0x0000000000000000000000000000000000000002' as Address;
const CHAIN_ID = 31337;

/** A controllable fake of the few PublicClient methods the manager uses. */
function mockClient(initial?: { latest?: number; pending?: number }) {
  const counts = new Map<string, { latest: number; pending: number }>();
  const def = { latest: initial?.latest ?? 0, pending: initial?.pending ?? initial?.latest ?? 0 };

  const getTransactionCount = vi.fn(
    async ({ address, blockTag }: { address: Address; blockTag: 'latest' | 'pending' }) => {
      const c = counts.get(address.toLowerCase()) ?? def;
      return blockTag === 'pending' ? c.pending : c.latest;
    },
  );

  const client = {
    chain: { id: CHAIN_ID },
    getChainId: async () => CHAIN_ID,
    getTransactionCount,
    estimateFeesPerGas: async () => ({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }),
    getGasPrice: async () => 100n,
  } as unknown as PublicClient;

  return {
    client,
    getTransactionCount,
    setCounts(address: Address, latest: number, pending = latest) {
      counts.set(address.toLowerCase(), { latest, pending });
    },
  };
}

describe('createNonceManager — allocation', () => {
  it('initializes from chain and hands out sequential nonces', async () => {
    const { client } = mockClient({ latest: 5, pending: 5 });
    const m = createNonceManager({ client });

    expect(await m.peek(ACCOUNT)).toBe(5);
    expect(await m.allocate(ACCOUNT)).toBe(5);
    expect(await m.allocate(ACCOUNT)).toBe(6);
    expect(await m.peek(ACCOUNT)).toBe(7);
  });

  // Headline edge case: 50 parallel allocations -> 50 distinct, contiguous, ordered.
  it('returns 50 distinct contiguous nonces under concurrency', async () => {
    const { client } = mockClient({ latest: 100, pending: 100 });
    const m = createNonceManager({ client });

    const nonces = await Promise.all(Array.from({ length: 50 }, () => m.allocate(ACCOUNT)));
    nonces.sort((a, b) => a - b);
    expect(nonces).toEqual(Array.from({ length: 50 }, (_, i) => 100 + i));
  });

  it('runs independent accounts in parallel without cross-blocking', async () => {
    const { client } = mockClient({ latest: 0, pending: 0 });
    const m = createNonceManager({ client });

    const [a, b] = await Promise.all([
      Promise.all(Array.from({ length: 10 }, () => m.allocate(ACCOUNT))),
      Promise.all(Array.from({ length: 10 }, () => m.allocate(ACCOUNT_B))),
    ]);
    expect([...a].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect([...b].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe('createNonceManager — withNonce', () => {
  it('releases the nonce when the callback throws, so it is reused (no gap)', async () => {
    const { client } = mockClient({ latest: 0, pending: 0 });
    const m = createNonceManager({ client });

    await expect(
      m.withNonce(ACCOUNT, async () => {
        throw new Error('broadcast failed: network down');
      }),
    ).rejects.toThrow('broadcast failed');

    // The failed nonce (0) is reused, not skipped.
    expect(await m.allocate(ACCOUNT)).toBe(0);
    expect(await m.allocate(ACCOUNT)).toBe(1);
  });

  it('returns the callback result on success', async () => {
    const { client } = mockClient({ latest: 3, pending: 3 });
    const m = createNonceManager({ client });
    const hash = await m.withNonce(ACCOUNT, async (nonce) => `tx-with-nonce-${nonce}`);
    expect(hash).toBe('tx-with-nonce-3');
  });

  it('recovers from "nonce too low": resyncs and throws a typed error', async () => {
    const env = mockClient({ latest: 0, pending: 0 });
    const m = createNonceManager({ client: env.client });

    // Simulate the chain having moved ahead (e.g. another sender) before broadcast.
    await expect(
      m.withNonce(ACCOUNT, async () => {
        env.setCounts(ACCOUNT, 4, 4);
        throw new Error('nonce too low');
      }),
    ).rejects.toBeInstanceOf(NonceTooLowError);

    // After resync the manager allocates from the recovered, correct nonce.
    expect(await m.allocate(ACCOUNT)).toBe(4);
  });
});

describe('createNonceManager — confirm / status / resync', () => {
  it('tracks in-flight count as nonces are allocated and confirmed', async () => {
    const { client } = mockClient({ latest: 0, pending: 0 });
    const m = createNonceManager({ client });

    await m.allocate(ACCOUNT); // 0
    await m.allocate(ACCOUNT); // 1
    await m.allocate(ACCOUNT); // 2
    expect(await m.status(ACCOUNT)).toEqual({ confirmed: 0, allocated: 3, inFlight: 3 });

    await m.confirm(ACCOUNT, 0);
    await m.confirm(ACCOUNT, 1);
    expect(await m.status(ACCOUNT)).toEqual({ confirmed: 2, allocated: 3, inFlight: 1 });
  });

  it('resync reconciles drift from the chain', async () => {
    const env = mockClient({ latest: 0, pending: 0 });
    const m = createNonceManager({ client: env.client });

    await m.allocate(ACCOUNT); // 0
    env.setCounts(ACCOUNT, 5, 5); // chain advanced underneath us
    const status = await m.resync(ACCOUNT);
    expect(status.confirmed).toBe(5);
    expect(status.allocated).toBe(5);
  });
});

describe('createNonceManager — restart rehydration', () => {
  it('rehydrates from the store and reconciles with chain on first use', async () => {
    const store = new InMemoryNonceStore();
    // Pretend a previous process persisted state at nonce 10.
    await store.set(makeKey(CHAIN_ID, ACCOUNT), { confirmed: 8, next: 10, released: [] });

    const env = mockClient({ latest: 0, pending: 0 });
    env.setCounts(ACCOUNT, 9, 9); // chain confirmed one more while we were down
    const m = createNonceManager({ client: env.client, store, reconcileOnStart: true });

    const status = await m.status(ACCOUNT);
    expect(status.confirmed).toBe(9); // advanced from persisted 8
    expect(status.allocated).toBe(10); // watermark preserved
  });
});

describe('createNonceManager — stuck-tx helpers', () => {
  let m: ReturnType<typeof createNonceManager>;
  beforeEach(() => {
    m = createNonceManager({ client: mockClient({ latest: 0, pending: 0 }).client });
  });

  it('buildReplacement resends the original call at the same nonce with bumped fees', async () => {
    const req = await m.buildReplacement(ACCOUNT, 7, {
      to: ACCOUNT_B,
      value: 1000n,
      data: '0xdeadbeef',
      gas: 60_000n,
      fees: { maxFeePerGas: 100n, maxPriorityFeePerGas: 10n },
    });
    expect(req.nonce).toBe(7);
    expect(req.to).toBe(ACCOUNT_B);
    expect(req).toMatchObject({ maxFeePerGas: 110n, maxPriorityFeePerGas: 11n });
  });

  it('buildCancellation builds a 0-value self-send with a >=10% bump', async () => {
    const req = await m.buildCancellation(ACCOUNT, 7, {
      fees: { maxFeePerGas: 100n, maxPriorityFeePerGas: 10n },
      feeBumpPercent: 5, // below minimum -> floored to 10
    });
    expect(req).toMatchObject({
      from: ACCOUNT,
      to: ACCOUNT,
      value: 0n,
      data: '0x',
      nonce: 7,
      maxFeePerGas: 110n,
      maxPriorityFeePerGas: 11n,
    });
  });
});
