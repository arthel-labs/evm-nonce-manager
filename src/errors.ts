/**
 * Error taxonomy for the nonce manager.
 *
 * Every error thrown by the public API extends {@link NonceManagerError}, so
 * callers can `catch (e) { if (e instanceof NonceManagerError) ... }` and
 * branch on the specific subclass.
 */

export class NonceManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
    // Restore prototype chain for instanceof across transpilation targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * The node reported the account's nonce as too low — i.e. a transaction was
 * broadcast with a nonce that has already been used on chain. The manager's
 * view of `confirmed` has drifted behind reality; recover with `resync`.
 */
export class NonceTooLowError extends NonceManagerError {
  constructor(
    readonly account: string,
    readonly attemptedNonce: number,
    cause?: unknown,
  ) {
    super(`nonce too low for ${account}: attempted ${attemptedNonce} but chain has moved past it`);
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * The node reported the nonce as too high, or a gap was detected: a transaction
 * references a nonce ahead of the next expected one, so it will sit queued until
 * the gap is filled. Surface clearly and recover with `resync`.
 */
export class NonceTooHighError extends NonceManagerError {
  constructor(
    readonly account: string,
    readonly attemptedNonce: number,
    readonly expectedNonce: number,
    cause?: unknown,
  ) {
    super(
      `nonce too high for ${account}: attempted ${attemptedNonce} but chain expects ${expectedNonce} — a gap exists`,
    );
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * A lower-level invariant was violated by a caller — e.g. releasing or confirming
 * a nonce that was never allocated. Indicates a bug in the calling code rather
 * than a chain condition.
 */
export class InvalidNonceError extends NonceManagerError {
  constructor(message: string) {
    super(message);
  }
}
