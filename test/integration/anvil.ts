import { type ChildProcess, spawn, spawnSync } from 'node:child_process';

/** Anvil's first two deterministic dev accounts (public keys + private keys). */
export const ACCOUNTS = [
  {
    address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
    privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  },
  {
    address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    privateKey: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  },
] as const;

/** True when the `anvil` binary is on PATH, so integration tests can be skipped. */
export function anvilAvailable(): boolean {
  const res = spawnSync('anvil', ['--version'], { stdio: 'ignore' });
  return res.status === 0;
}

export interface AnvilHandle {
  url: string;
  stop: () => void;
}

/** Launch an Anvil node and resolve once its JSON-RPC answers. */
export async function startAnvil(): Promise<AnvilHandle> {
  // Derive a port from the pid to avoid clashes across parallel test files.
  const port = 8545 + (process.pid % 2000);
  const url = `http://127.0.0.1:${port}`;
  const proc: ChildProcess = spawn('anvil', ['--port', String(port), '--silent'], {
    stdio: 'ignore',
  });

  await waitForRpc(url, proc);
  return {
    url,
    stop: () => {
      proc.kill('SIGTERM');
    },
  };
}

async function waitForRpc(url: string, proc: ChildProcess): Promise<void> {
  const deadline = Date.now() + 15_000;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`anvil exited early with code ${proc.exitCode}`);
    }
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill('SIGTERM');
  throw new Error(`anvil RPC did not come up at ${url}: ${String(lastErr)}`);
}
