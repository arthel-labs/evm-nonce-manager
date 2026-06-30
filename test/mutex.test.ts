import { describe, expect, it } from 'vitest';
import { KeyedMutex } from '../src/core/mutex.js';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('KeyedMutex', () => {
  it('serializes operations within a single key', async () => {
    const mutex = new KeyedMutex();
    const order: number[] = [];

    // Fire 5 ops that would interleave if unsynchronized (decreasing delays).
    const ops = Array.from({ length: 5 }, (_, i) =>
      mutex.runExclusive('acct', async () => {
        await tick((5 - i) * 5);
        order.push(i);
      }),
    );
    await Promise.all(ops);

    expect(order).toEqual([0, 1, 2, 3, 4]); // strict arrival order, no interleave
  });

  it('runs different keys in parallel', async () => {
    const mutex = new KeyedMutex();
    let aRunning = false;
    let overlapped = false;

    const a = mutex.runExclusive('a', async () => {
      aRunning = true;
      await tick(30);
      aRunning = false;
    });
    const b = mutex.runExclusive('b', async () => {
      // If keys were serialized together, a would have finished first.
      if (aRunning) overlapped = true;
    });

    await Promise.all([a, b]);
    expect(overlapped).toBe(true);
  });

  it('keeps the queue alive after an operation throws', async () => {
    const mutex = new KeyedMutex();
    const results: string[] = [];

    const failing = mutex
      .runExclusive('acct', async () => {
        throw new Error('boom');
      })
      .catch((e: Error) => results.push(`caught:${e.message}`));
    const following = mutex.runExclusive('acct', async () => {
      results.push('ran-after-failure');
    });

    await Promise.all([failing, following]);
    // The failing op rejects its own caller, but the next queued op still runs.
    expect(results).toContain('caught:boom');
    expect(results).toContain('ran-after-failure');
  });

  it('garbage-collects idle mutexes', async () => {
    const mutex = new KeyedMutex();
    await mutex.runExclusive('acct', async () => tick(1));
    expect(mutex.size).toBe(0);
  });

  it('returns the operation result to the caller', async () => {
    const mutex = new KeyedMutex();
    const value = await mutex.runExclusive('acct', async () => 42);
    expect(value).toBe(42);
  });
});
