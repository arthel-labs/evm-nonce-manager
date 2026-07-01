import {
  type PublicClient,
  type TestClient,
  type WalletClient,
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNonceManager } from '../../src/index.js';
import { ACCOUNTS, type AnvilHandle, anvilAvailable, startAnvil } from './anvil.js';

const RECIPIENT = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
// High-concurrency load. Override with STRESS_N to push harder locally.
const N = Number(process.env.STRESS_N ?? 1000);

const describeAnvil = anvilAvailable() ? describe : describe.skip;

/**
 * Concurrency stress test: fire N `withNonce` sends at once against a real node
 * and assert the manager hands out N distinct, contiguous nonces with zero gaps
 * — the core guarantee, exercised at scale rather than with a toy count.
 */
describeAnvil(`integration: ${N} concurrent sends`, () => {
  let anvil: AnvilHandle;
  let publicClient: PublicClient;
  let walletClient: WalletClient;
  let testClient: TestClient;
  const account = privateKeyToAccount(ACCOUNTS[0].privateKey);

  beforeAll(async () => {
    anvil = await startAnvil();
    const transport = http(anvil.url);
    publicClient = createPublicClient({ chain: foundry, transport });
    walletClient = createWalletClient({ chain: foundry, account, transport });
    testClient = createTestClient({ chain: foundry, mode: 'anvil', transport });
  }, 30_000);

  afterAll(() => anvil?.stop());

  it(`allocates ${N} distinct, contiguous nonces with zero gaps`, async () => {
    const manager = createNonceManager({ client: publicClient });
    const start = await publicClient.getTransactionCount({
      address: account.address,
      blockTag: 'latest',
    });

    // Fixed fees + local signing so each send is one RPC call (no per-tx prep),
    // and batch the mempool so N sends don't each wait on their own block.
    const maxFeePerGas = 100_000_000_000n; // 100 gwei
    const maxPriorityFeePerGas = 1_000_000_000n; // 1 gwei
    await testClient.setAutomine(false);

    const nonces: number[] = [];
    const hashes = await Promise.all(
      Array.from({ length: N }, () =>
        manager.withNonce(account.address, async (nonce) => {
          nonces.push(nonce);
          const serialized = await walletClient.signTransaction({
            account,
            chain: foundry,
            to: RECIPIENT,
            value: 1n,
            nonce,
            gas: 21_000n,
            maxFeePerGas,
            maxPriorityFeePerGas,
          });
          return walletClient.sendRawTransaction({ serializedTransaction: serialized });
        }),
      ),
    );

    // Mine everything, then let the chain be the final arbiter.
    await testClient.mine({ blocks: Math.ceil(N / 200) + 2 });
    await testClient.setAutomine(true);

    expect(hashes).toHaveLength(N);

    // N distinct nonces...
    expect(new Set(nonces).size).toBe(N);
    // ...that are exactly start..start+N-1 with no gap.
    expect([...nonces].sort((a, b) => a - b)).toEqual(
      Array.from({ length: N }, (_, i) => start + i),
    );

    // The chain advanced by exactly N: every tx landed, nothing stuck.
    const end = await publicClient.getTransactionCount({
      address: account.address,
      blockTag: 'latest',
    });
    expect(end).toBe(start + N);

    await manager.resync(account.address);
    expect(await manager.status(account.address)).toEqual({
      confirmed: start + N,
      allocated: start + N,
      inFlight: 0,
    });
  });
});
