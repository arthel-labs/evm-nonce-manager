import type { Address, PublicClient } from 'viem';
import { NonceTooHighError, NonceTooLowError } from '../errors.js';
import type { Eip1559Fees } from '../types.js';

/**
 * Thin adapter around a Viem {@link PublicClient}. This is the only place the
 * library touches the network — keeping it small and isolated is what lets the
 * state machine stay pure and fully unit-testable.
 */
export class ChainAdapter {
  constructor(private readonly client: PublicClient) {}

  /** Resolve the chain id, preferring the statically-configured one. */
  async chainId(): Promise<number> {
    return this.client.chain?.id ?? (await this.client.getChainId());
  }

  /**
   * Fetch the account's `latest` (mined) and `pending` (mined + mempool)
   * transaction counts — the on-chain source of truth for reconciliation.
   */
  async getCounts(account: Address): Promise<{ latest: number; pending: number }> {
    const [latest, pending] = await Promise.all([
      this.client.getTransactionCount({ address: account, blockTag: 'latest' }),
      this.client.getTransactionCount({ address: account, blockTag: 'pending' }),
    ]);
    return { latest, pending };
  }

  /** Current EIP-1559 fee suggestion, used when the caller gives no originals. */
  async suggestEip1559Fees(): Promise<Eip1559Fees> {
    const { maxFeePerGas, maxPriorityFeePerGas } = await this.client.estimateFeesPerGas();
    return { maxFeePerGas, maxPriorityFeePerGas };
  }

  /** Current legacy gas price suggestion. */
  async suggestGasPrice(): Promise<bigint> {
    return this.client.getGasPrice();
  }

  /**
   * Map a raw broadcast error into a typed nonce error when it is one. Returns
   * `undefined` for unrelated errors so the caller can rethrow the original.
   */
  classifyBroadcastError(
    error: unknown,
    account: Address,
    attemptedNonce: number,
    expectedNonce: number,
  ): NonceTooLowError | NonceTooHighError | undefined {
    const text = errorText(error).toLowerCase();
    if (text.includes('nonce too low') || text.includes('already known') || text.includes('already imported')) {
      return new NonceTooLowError(account, attemptedNonce, error);
    }
    if (text.includes('nonce too high') || text.includes('nonce gap') || text.includes('too high')) {
      return new NonceTooHighError(account, attemptedNonce, expectedNonce, error);
    }
    return undefined;
  }
}

/** Flatten a viem/JSON-RPC error into searchable text. */
function errorText(error: unknown): string {
  if (error instanceof Error) {
    // Viem nests the node message under details/shortMessage/cause.
    const parts = [error.message];
    const withDetails = error as { details?: unknown; shortMessage?: unknown; cause?: unknown };
    if (typeof withDetails.details === 'string') parts.push(withDetails.details);
    if (typeof withDetails.shortMessage === 'string') parts.push(withDetails.shortMessage);
    if (withDetails.cause) parts.push(errorText(withDetails.cause));
    return parts.join(' | ');
  }
  return String(error);
}
