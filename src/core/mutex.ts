/**
 * Minimal async mutex and a keyed registry of them.
 *
 * The nonce manager serializes all state transitions for a single account so
 * allocation is race-free, while *different* accounts run fully in parallel.
 * {@link KeyedMutex.runExclusive} queues per key but never blocks across keys.
 */

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  /** Operations queued or running; when zero the mutex can be discarded. */
  private pending = 0;

  /** Run `fn` after all previously-queued work for this mutex completes. */
  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    this.pending += 1;
    // Chain onto the tail so callers run strictly in arrival order. Swallow
    // errors on the chain itself so one rejection doesn't wedge the queue;
    // the original result/rejection is still returned to *this* caller.
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await result;
    } finally {
      this.pending -= 1;
    }
  }

  /** True when nothing is queued or running — safe to garbage-collect. */
  get idle(): boolean {
    return this.pending === 0;
  }
}

/** A per-key collection of mutexes that serializes work within each key. */
export class KeyedMutex {
  private readonly mutexes = new Map<string, Mutex>();

  async runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    let mutex = this.mutexes.get(key);
    if (!mutex) {
      mutex = new Mutex();
      this.mutexes.set(key, mutex);
    }
    try {
      return await mutex.runExclusive(fn);
    } finally {
      // Drop idle mutexes so a long-lived manager doesn't leak one entry per
      // account it has ever seen.
      if (mutex.idle && this.mutexes.get(key) === mutex) {
        this.mutexes.delete(key);
      }
    }
  }

  /** Number of live (queued) keys — exposed for tests/introspection. */
  get size(): number {
    return this.mutexes.size;
  }
}
