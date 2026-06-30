import {
  type PublicClient,
  type TestClient,
  type WalletClient,
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  parseEther,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createNonceManager } from '../../src/index.js';
import { ACCOUNTS, type AnvilHandle, anvilAvailable, startAnvil } from './anvil.js';

const RECIPIENT = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

// Integration tests need a real node; skip cleanly when Foundry isn't installed.
const describeAnvil = anvilAvailable() ? describe : describe.skip;

describeAnvil('integration: nonce manager against Anvil', () => {
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

  it('fires concurrent transactions with distinct, contiguous nonces and zero gaps', async () => {
    const manager = createNonceManager({ client: publicClient });
    const start = await publicClient.getTransactionCount({
      address: account.address,
      blockTag: 'latest',
    });

    const N = 20;
    const usedNonces: number[] = [];
    const hashes = await Promise.all(
      Array.from({ length: N }, () =>
        manager.withNonce(account.address, async (nonce) => {
          usedNonces.push(nonce);
          return walletClient.sendTransaction({
            account,
            chain: foundry,
            to: RECIPIENT,
            value: 1n,
            nonce,
          });
        }),
      ),
    );

    // Every send got a distinct, contiguous nonce.
    expect(new Set(usedNonces).size).toBe(N);
    expect([...usedNonces].sort((a, b) => a - b)).toEqual(
      Array.from({ length: N }, (_, i) => start + i),
    );

    // All mined; the chain advanced by exactly N with no gap.
    await Promise.all(hashes.map((hash) => publicClient.waitForTransactionReceipt({ hash })));
    const end = await publicClient.getTransactionCount({
      address: account.address,
      blockTag: 'latest',
    });
    expect(end).toBe(start + N);
  });

  it('releases the nonce on a failed broadcast so no permanent gap forms', async () => {
    const manager = createNonceManager({ client: publicClient });
    const before = await manager.peek(account.address);

    // A withNonce whose callback throws before broadcasting.
    await expect(
      manager.withNonce(account.address, async () => {
        throw new Error('simulated broadcast failure');
      }),
    ).rejects.toThrow('simulated broadcast failure');

    // The very next real send reuses the released nonce — no gap.
    const hash = await manager.withNonce(account.address, async (nonce) => {
      expect(nonce).toBe(before);
      return walletClient.sendTransaction({
        account,
        chain: foundry,
        to: RECIPIENT,
        value: 1n,
        nonce,
      });
    });
    await publicClient.waitForTransactionReceipt({ hash });
    expect(await manager.peek(account.address)).toBe(before + 1);
  });

  it('replaces a stuck (underpriced) pending transaction with a fee-bumped one', async () => {
    const manager = createNonceManager({ client: publicClient });

    // Pause mining so an underpriced tx sits pending in the mempool.
    await testClient.setAutomine(false);

    const nonce = await manager.allocate(account.address);
    const lowFees = { maxFeePerGas: parseEther('0.000000002'), maxPriorityFeePerGas: 1n };

    const stuckHash = await walletClient.sendTransaction({
      account,
      chain: foundry,
      to: RECIPIENT,
      value: 1n,
      nonce,
      ...lowFees,
    });

    // Build a same-nonce replacement bumped relative to the stuck tx's fees.
    const replacement = await manager.buildReplacement(
      account.address,
      nonce,
      { to: RECIPIENT, value: 1n, gas: 21_000n, fees: lowFees },
      { feeBumpPercent: 20 },
    );
    const replacementHash = await walletClient.sendTransaction({
      account,
      chain: foundry,
      ...replacement,
    });

    // Mine: the higher-fee replacement is included; the stuck tx is evicted.
    await testClient.mine({ blocks: 1 });
    await testClient.setAutomine(true);

    const replacementReceipt = await publicClient.getTransactionReceipt({ hash: replacementHash });
    expect(replacementReceipt.status).toBe('success');

    const stuckReceipt = await publicClient
      .getTransactionReceipt({ hash: stuckHash })
      .catch(() => null);
    expect(stuckReceipt).toBeNull(); // original never mined

    await manager.confirm(account.address, nonce);
    expect((await manager.status(account.address)).confirmed).toBe(nonce + 1);
  });
});
