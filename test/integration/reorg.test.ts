import {
  type Hex,
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
const N = 5;

const describeAnvil = anvilAvailable() ? describe : describe.skip;

/**
 * A GENUINE live-chain reorg test. It does not hand-feed reconcile() a number:
 * it snapshots Anvil, mines real transactions, then reverts so those blocks are
 * un-mined and the account's on-chain nonce actually regresses. It then drives
 * the manager's real recovery path (resync → reconcile) and proves the manager
 * ends up in a consistent state that can allocate and send correctly again.
 */
describeAnvil('integration: recovery from a real Anvil reorg', () => {
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

  const onChainNonce = () =>
    publicClient.getTransactionCount({ address: account.address, blockTag: 'latest' });

  /** Sign and broadcast a value transfer at an explicit nonce; keep the raw tx. */
  async function sendAt(nonce: number): Promise<{ hash: Hex; serialized: Hex }> {
    const request = await walletClient.prepareTransactionRequest({
      account,
      chain: foundry,
      to: RECIPIENT,
      value: 1n,
      nonce,
    });
    const serialized = await walletClient.signTransaction(request);
    const hash = await walletClient.sendRawTransaction({ serializedTransaction: serialized });
    return { hash, serialized };
  }

  it('regresses confirmed on a real reorg, stays consistent, and recovers end-to-end', async () => {
    const manager = createNonceManager({ client: publicClient });
    const start = await onChainNonce();

    // --- 1. Snapshot BEFORE the txs exist, so reverting un-mines them. --------
    const snapshotId = await testClient.snapshot();

    // --- 2. Allocate via the manager, mine N real transactions. --------------
    const raws: Hex[] = [];
    for (let i = 0; i < N; i++) {
      const nonce = await manager.allocate(account.address);
      expect(nonce).toBe(start + i);
      const { hash, serialized } = await sendAt(nonce);
      raws.push(serialized);
      await publicClient.waitForTransactionReceipt({ hash });
    }

    expect(await onChainNonce()).toBe(start + N); // chain advanced for real
    let status = await manager.resync(account.address);
    expect(status).toEqual({ confirmed: start + N, allocated: start + N, inFlight: 0 });

    // --- 3. THE REORG: revert the chain so those N blocks are un-mined. -------
    await testClient.revert({ id: snapshotId });
    const afterReorg = await onChainNonce();
    expect(afterReorg).toBe(start); // on-chain nonce genuinely regressed

    // --- 4. Recovery path: resync/reconcile as production would. -------------
    // The manager must regress `confirmed` to match the chain WITHOUT corrupting
    // allocation state: the watermark is preserved and the N reorged nonces are
    // reported back as in-flight (they need re-broadcasting), not silently lost.
    status = await manager.resync(account.address);
    expect(status).toEqual({
      confirmed: start, // regressed to chain reality
      allocated: start + N, // watermark preserved
      inFlight: N, // the N reorged txs are surfaced as in-flight
    });

    // --- 5. Re-broadcast the reorged txs (normal post-reorg production step). -
    for (const serialized of raws) {
      const hash = await walletClient.sendRawTransaction({ serializedTransaction: serialized });
      await publicClient.waitForTransactionReceipt({ hash });
    }
    expect(await onChainNonce()).toBe(start + N); // chain caught back up
    status = await manager.resync(account.address);
    expect(status).toEqual({ confirmed: start + N, allocated: start + N, inFlight: 0 });

    // --- 6. Prove usability: a fresh allocate+send works correctly. -----------
    const freshNonce = await manager.allocate(account.address);
    expect(freshNonce).toBe(start + N);
    const { hash } = await sendAt(freshNonce);
    await publicClient.waitForTransactionReceipt({ hash });
    expect(await onChainNonce()).toBe(start + N + 1);
    expect(await manager.resync(account.address)).toEqual({
      confirmed: start + N + 1,
      allocated: start + N + 1,
      inFlight: 0,
    });
  });
});
