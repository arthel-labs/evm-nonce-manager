import { describe, expect, it } from 'vitest';
import { InMemoryNonceStore } from '../src/store/memory-store.js';
import { makeKey } from '../src/internal/keys.js';

describe('InMemoryNonceStore', () => {
  it('round-trips state by key', async () => {
    const store = new InMemoryNonceStore();
    const key = makeKey(1, '0xAbC0000000000000000000000000000000000001');
    expect(await store.get(key)).toBeUndefined();
    await store.set(key, { confirmed: 1, next: 3, released: [2] });
    expect(await store.get(key)).toEqual({ confirmed: 1, next: 3, released: [2] });
  });

  it('isolates stored snapshots from external mutation', async () => {
    const store = new InMemoryNonceStore();
    const key = makeKey(1, '0x0000000000000000000000000000000000000001');
    const input = { confirmed: 0, next: 1, released: [] as number[] };
    await store.set(key, input);
    input.released.push(99); // mutate after storing

    const got = (await store.get(key))!;
    expect(got.released).toEqual([]);
    got.released.push(42); // mutate the returned copy
    expect((await store.get(key))!.released).toEqual([]); // store unaffected
  });
});

describe('makeKey', () => {
  it('lower-cases the address and keys by chain', () => {
    expect(makeKey(31337, '0xAbCdEf0000000000000000000000000000000001')).toBe(
      '31337:0xabcdef0000000000000000000000000000000001',
    );
  });
});
