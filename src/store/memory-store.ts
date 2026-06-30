import type { NonceStateKey, NonceStore, PersistedNonceState } from '../types.js';

/**
 * Default in-process {@link NonceStore}. State lives in a `Map` and is lost on
 * restart — which is exactly why the store is pluggable: swap in a Redis or
 * Postgres implementation of the same interface to survive restarts. See the
 * "Pluggable persistence" section of the README for the extension point.
 *
 * Values are deep-copied on the way in and out so callers can never mutate the
 * stored snapshot by holding a reference to it.
 */
export class InMemoryNonceStore implements NonceStore {
  private readonly map = new Map<NonceStateKey, PersistedNonceState>();

  async get(key: NonceStateKey): Promise<PersistedNonceState | undefined> {
    const value = this.map.get(key);
    return value ? clone(value) : undefined;
  }

  async set(key: NonceStateKey, state: PersistedNonceState): Promise<void> {
    this.map.set(key, clone(state));
  }
}

function clone(state: PersistedNonceState): PersistedNonceState {
  return { confirmed: state.confirmed, next: state.next, released: [...state.released] };
}
