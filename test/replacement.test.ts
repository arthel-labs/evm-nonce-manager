import { describe, expect, it } from 'vitest';
import {
  MIN_REPLACEMENT_BUMP_PERCENT,
  buildCancellationRequest,
  buildReplacementRequest,
  bumpFees,
  bumpValue,
  effectiveBumpPercent,
  isEip1559,
} from '../src/replacement.js';

describe('bumpValue', () => {
  it('raises by the given percent, rounding up so it strictly exceeds', () => {
    expect(bumpValue(100n, 10)).toBe(110n);
    expect(bumpValue(1n, 10)).toBe(2n); // ceil(1.1) -> 2, strictly higher
    expect(bumpValue(999n, 10)).toBe(1099n); // ceil(1098.9)
  });

  it('leaves zero untouched (no percentage of zero to bump)', () => {
    expect(bumpValue(0n, 50)).toBe(0n);
  });
});

describe('effectiveBumpPercent', () => {
  it('floors at the network minimum', () => {
    expect(effectiveBumpPercent(5, 10)).toBe(MIN_REPLACEMENT_BUMP_PERCENT);
    expect(effectiveBumpPercent(undefined, 8)).toBe(MIN_REPLACEMENT_BUMP_PERCENT);
  });

  it('honors a larger requested bump', () => {
    expect(effectiveBumpPercent(25, 10)).toBe(25);
    expect(effectiveBumpPercent(undefined, 30)).toBe(30);
  });
});

describe('bumpFees', () => {
  it('bumps both EIP-1559 fields', () => {
    const out = bumpFees({ maxFeePerGas: 100n, maxPriorityFeePerGas: 20n }, 10);
    expect(out).toEqual({ maxFeePerGas: 110n, maxPriorityFeePerGas: 22n });
    expect(isEip1559(out)).toBe(true);
  });

  it('bumps legacy gasPrice', () => {
    expect(bumpFees({ gasPrice: 200n }, 50)).toEqual({ gasPrice: 300n });
  });
});

describe('buildReplacementRequest', () => {
  it('preserves the call and nonce while bumping fees', () => {
    const req = buildReplacementRequest({
      from: '0xabc',
      to: '0xdef',
      value: 5n,
      data: '0x1234',
      gas: 50_000n,
      nonce: 7,
      fees: { maxFeePerGas: 100n, maxPriorityFeePerGas: 10n },
      bumpPercent: 10,
    });
    expect(req).toEqual({
      from: '0xabc',
      to: '0xdef',
      value: 5n,
      data: '0x1234',
      gas: 50_000n,
      nonce: 7,
      maxFeePerGas: 110n,
      maxPriorityFeePerGas: 11n,
    });
  });
});

describe('buildCancellationRequest', () => {
  it('is a 0-value self-send at the same nonce with bumped fees', () => {
    const req = buildCancellationRequest({
      from: '0xabc',
      gas: 21_000n,
      nonce: 7,
      fees: { gasPrice: 100n },
      bumpPercent: 20,
    });
    expect(req).toEqual({
      from: '0xabc',
      to: '0xabc',
      value: 0n,
      data: '0x',
      gas: 21_000n,
      nonce: 7,
      gasPrice: 120n,
    });
  });
});
