/**
 * Runnable demo: fire many concurrent transactions through the nonce manager
 * and watch them come out with distinct, contiguous nonces and zero gaps.
 *
 *   1. In one terminal:  anvil
 *   2. In another:       npm run example
 *
 * NEVER point this at a real network — Anvil / a local devnet only.
 */
import { createPublicClient, createWalletClient, http, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { createNonceManager } from '../src/index.js';

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const CONCURRENCY = 25;

// Anvil's first deterministic dev account. Public test key — not a secret.
const account = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
);
const RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

async function main(): Promise<void> {
  const transport = http(RPC_URL);
  const publicClient = createPublicClient({ chain: foundry, transport }) as PublicClient;
  const walletClient = createWalletClient({ chain: foundry, account, transport });

  await assertReachable(publicClient);

  const manager = createNonceManager({ client: publicClient });
  const start = await publicClient.getTransactionCount({
    address: account.address,
    blockTag: 'latest',
  });

  console.log(`Account ${account.address}`);
  console.log(`Starting nonce: ${start}`);
  console.log(`Firing ${CONCURRENCY} transactions concurrently...\n`);

  const order: { order: number; nonce: number; hash: string }[] = [];
  let dispatched = 0;

  const hashes = await Promise.all(
    Array.from({ length: CONCURRENCY }, () =>
      manager.withNonce(account.address, async (nonce) => {
        const seq = dispatched++;
        const hash = await walletClient.sendTransaction({
          account,
          chain: foundry,
          to: RECIPIENT,
          value: 1n,
          nonce,
        });
        order.push({ order: seq, nonce, hash });
        return hash;
      }),
    ),
  );

  await Promise.all(hashes.map((hash) => publicClient.waitForTransactionReceipt({ hash })));

  order.sort((a, b) => a.nonce - b.nonce);
  console.log('nonce  hash');
  console.log('-----  ----');
  for (const row of order) {
    console.log(`${String(row.nonce).padEnd(5)}  ${row.hash}`);
  }

  const nonces = order.map((r) => r.nonce);
  const contiguous = nonces.every((n, i) => n === start + i);
  const end = await publicClient.getTransactionCount({
    address: account.address,
    blockTag: 'latest',
  });

  // Reconcile so the confirmed pointer catches up to what the chain mined.
  await manager.resync(account.address);

  console.log('');
  console.log(`Distinct nonces : ${new Set(nonces).size}/${CONCURRENCY}`);
  console.log(`Contiguous      : ${contiguous ? 'yes ✅' : 'NO ❌'}`);
  console.log(`Chain nonce now : ${end} (expected ${start + CONCURRENCY})`);
  console.log(`Status          :`, await manager.status(account.address));
}

async function assertReachable(client: PublicClient): Promise<void> {
  try {
    await client.getChainId();
  } catch {
    console.error(`Could not reach a node at ${RPC_URL}.`);
    console.error('Start a local node first:  anvil');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
