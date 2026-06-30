import { describe, expect, it } from 'vitest';
import {
  allocate,
  confirm,
  init,
  peek,
  reconcile,
  release,
  status,
} from '../src/core/state-machine.js';
import { InvalidNonceError } from '../src/errors.js';
import type { PersistedNonceState } from '../src/types.js';

/** Allocate `n` nonces in sequence, threading state. */
function allocateMany(start: PersistedNonceState, n: number): { state: PersistedNonceState; nonces: number[] } {
  let state = start;
  const nonces: number[] = [];
  for (let i = 0; i < n; i++) {
    const res = allocate(state);
    state = res.state;
    nonces.push(res.nonce);
  }
  return { state, nonces };
}

describe('init', () => {
  it('seeds confirmed from latest and next from pending', () => {
    expect(init(5, 8)).toEqual({ confirmed: 5, next: 8, released: [] });
  });

  it('clamps next to at least latest when pending lags', () => {
    expect(init(5, 3)).toEqual({ confirmed: 5, next: 5, released: [] });
  });

  it('rejects negative or non-integer counts', () => {
    expect(() => init(-1, 0)).toThrow(InvalidNonceError);
    expect(() => init(0, 1.5)).toThrow(InvalidNonceError);
  });
});

describe('allocate / peek', () => {
  it('hands out strictly sequential nonces from the watermark', () => {
    const { nonces } = allocateMany(init(0, 0), 5);
    expect(nonces).toEqual([0, 1, 2, 3, 4]);
  });

  it('peek does not consume', () => {
    const state = init(10, 10);
    expect(peek(state)).toBe(10);
    expect(peek(state)).toBe(10);
    expect(state.next).toBe(10);
  });

  // Edge case: "50 parallel allocate calls return 50 distinct, contiguous, ordered nonces".
  it('produces 50 distinct, contiguous, ordered nonces', () => {
    const { nonces } = allocateMany(init(100, 100), 50);
    expect(nonces).toHaveLength(50);
    expect(new Set(nonces).size).toBe(50);
    expect(nonces).toEqual(Array.from({ length: 50 }, (_, i) => 100 + i));
  });
});

describe('release', () => {
  it('reuses a released nonce before the watermark (no gap)', () => {
    let { state } = allocateMany(init(0, 0), 3); // allocated 0,1,2 -> next 3
    state = release(state, 1); // 1 failed broadcast
    const a = allocate(state);
    expect(a.nonce).toBe(1); // reused, not 3
    expect(allocate(a.state).nonce).toBe(3);
  });

  it('shrinks the watermark when releasing the top nonce', () => {
    const { state } = allocateMany(init(0, 0), 3); // next = 3
    const after = release(state, 2);
    expect(after.next).toBe(2);
    expect(after.released).toEqual([]);
  });

  it('absorbs contiguous released nonces when the watermark shrinks', () => {
    let { state } = allocateMany(init(0, 0), 4); // next = 4, allocated 0..3
    state = release(state, 2); // released [2]
    state = release(state, 3); // top -> shrink to 3, then absorb 2 -> next 2
    expect(state.next).toBe(2);
    expect(state.released).toEqual([]);
  });

  it('is idempotent and ignores already-confirmed nonces', () => {
    let { state } = allocateMany(init(0, 0), 3);
    state = release(state, 1);
    const again = release(state, 1);
    expect(again.released).toEqual([1]);

    const confirmed = release({ confirmed: 5, next: 8, released: [] }, 3);
    expect(confirmed.released).toEqual([]); // 3 < confirmed -> no-op
  });

  it('throws when releasing a never-allocated nonce', () => {
    const { state } = allocateMany(init(0, 0), 2); // next = 2
    expect(() => release(state, 5)).toThrow(InvalidNonceError);
  });
});

describe('confirm', () => {
  it('advances the confirmed pointer to nonce + 1', () => {
    const state: PersistedNonceState = { confirmed: 0, next: 5, released: [] };
    expect(confirm(state, 0).confirmed).toBe(1);
    expect(confirm(state, 2).confirmed).toBe(3); // implies 0,1 also mined
  });

  it('ignores stale or duplicate confirms', () => {
    const state: PersistedNonceState = { confirmed: 4, next: 6, released: [] };
    expect(confirm(state, 1)).toEqual(state);
    expect(confirm(state, 3)).toEqual(state);
  });

  it('drops released nonces that fall below the new confirmed pointer', () => {
    const state: PersistedNonceState = { confirmed: 0, next: 5, released: [1, 3] };
    const after = confirm(state, 2); // confirmed -> 3
    expect(after.confirmed).toBe(3);
    expect(after.released).toEqual([3]);
  });
});

describe('reconcile', () => {
  it('advances confirmed when the chain is ahead (e.g. nonce-too-low recovery)', () => {
    const state: PersistedNonceState = { confirmed: 2, next: 5, released: [3] };
    const after = reconcile(state, { latest: 4, pending: 4 });
    expect(after.confirmed).toBe(4);
    expect(after.next).toBe(5);
    expect(after.released).toEqual([]); // 3 < 4, dropped
  });

  it('raises the watermark to cover unknown pending txs', () => {
    const state: PersistedNonceState = { confirmed: 2, next: 4, released: [] };
    const after = reconcile(state, { latest: 2, pending: 7 });
    expect(after.next).toBe(7);
    expect(after.confirmed).toBe(2);
  });

  // Edge case: "Reorg -> confirmed nonce regresses; allocation state stays consistent".
  it('regresses confirmed on a reorg but preserves the watermark', () => {
    const state: PersistedNonceState = { confirmed: 6, next: 9, released: [] };
    const after = reconcile(state, { latest: 4, pending: 4 });
    expect(after.confirmed).toBe(4);
    expect(after.next).toBe(9); // pending allocations not reissued as fresh
  });

  it('is a no-op when the chain matches', () => {
    const state: PersistedNonceState = { confirmed: 3, next: 6, released: [4] };
    expect(reconcile(state, { latest: 3, pending: 6 })).toEqual(state);
  });
});

describe('status', () => {
  it('reports confirmed, allocated watermark, and in-flight count', () => {
    const state: PersistedNonceState = { confirmed: 2, next: 7, released: [4] };
    // in flight = 7 - 2 - 1(released) = 4  (nonces 2,3,5,6)
    expect(status(state)).toEqual({ confirmed: 2, allocated: 7, inFlight: 4 });
  });

  it('reports zero in-flight on a fresh, fully-confirmed account', () => {
    expect(status(init(10, 10))).toEqual({ confirmed: 10, allocated: 10, inFlight: 0 });
  });
});

describe('immutability', () => {
  it('never mutates the input state', () => {
    const state: PersistedNonceState = { confirmed: 0, next: 3, released: [1] };
    const snapshot = structuredClone(state);
    allocate(state);
    release(state, 2);
    confirm(state, 1);
    reconcile(state, { latest: 5, pending: 5 });
    status(state);
    expect(state).toEqual(snapshot);
  });
});
