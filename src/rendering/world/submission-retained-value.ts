import type { RHISubmission } from '../../rhi/contracts/submission';

export type SubmissionRetainedValueState = 'live' | 'retired' | 'destroyed';

export interface SubmissionRetainedValueSnapshot {
  readonly state: SubmissionRetainedValueState;
  readonly localLeases: number;
  readonly pendingSubmissions: number;
}

/** Explicit ownership handle for one device object that may cross a submission boundary. */
export interface SubmissionRetainedValueLease<T> {
  readonly value: T;
  readonly released: boolean;
  /** Keeps the value alive until a pending submission reaches any terminal outcome. */
  retain(submission: RHISubmission): void;
  /** Releases the caller's local ownership. This operation is idempotent. */
  release(): void;
}

/**
 * Owns one device value after publication and defers destruction across pending submissions.
 *
 * Retirement is immediate for lookup purposes. Destruction occurs only after every local lease
 * and retained submission has ended. Cleanup failures are contained for later diagnostics.
 */
export class SubmissionRetainedValue<T> {
  readonly #submissions = new Set<RHISubmission>();
  readonly #destroyErrors: unknown[] = [];
  readonly #destroy: (value: T) => void;
  readonly #onDestroyError: ((error: unknown) => void) | undefined;
  #state: SubmissionRetainedValueState = 'live';
  #localLeases = 0;

  constructor(
    readonly value: T,
    destroy: (value: T) => void,
    onDestroyError?: (error: unknown) => void
  ) {
    if (typeof destroy !== 'function')
      throw new Error('Submission-retained value destroy callback must be a function.');
    if (onDestroyError !== undefined && typeof onDestroyError !== 'function')
      throw new Error('Submission-retained value error callback must be a function.');
    this.#destroy = destroy;
    this.#onDestroyError = onDestroyError;
  }

  /** Acquires local ownership, or returns undefined after retirement. */
  acquire(): SubmissionRetainedValueLease<T> | undefined {
    if (this.#state !== 'live') return undefined;
    this.#localLeases += 1;
    let released = false;
    return Object.freeze({
      value: this.value,
      get released() {
        return released;
      },
      retain: (submission: RHISubmission) => {
        if (released) throw new Error('Submission-retained value lease has already been released.');
        validateSubmission(submission);
        if (submission.status !== 'pending' || this.#submissions.has(submission)) return;
        this.#submissions.add(submission);
        void submission.done.then(
          () => this.#releaseSubmission(submission),
          () => this.#releaseSubmission(submission)
        );
      },
      release: () => {
        if (released) return;
        released = true;
        this.#localLeases -= 1;
        this.#tryDestroy();
      }
    });
  }

  /** Stops new acquisitions and begins deferred destruction. */
  retire(): boolean {
    if (this.#state !== 'live') return false;
    this.#state = 'retired';
    this.#tryDestroy();
    return true;
  }

  /** Returns immutable structural lifetime state for diagnostics and deterministic tests. */
  snapshot(): Readonly<SubmissionRetainedValueSnapshot> {
    return Object.freeze({
      state: this.#state,
      localLeases: this.#localLeases,
      pendingSubmissions: this.#submissions.size
    });
  }

  /** Returns contained destruction failures without exposing mutable internal storage. */
  destroyErrors(): readonly unknown[] {
    return Object.freeze([...this.#destroyErrors]);
  }

  #releaseSubmission(submission: RHISubmission): void {
    if (!this.#submissions.delete(submission)) return;
    this.#tryDestroy();
  }

  #tryDestroy(): void {
    if (this.#state !== 'retired' || this.#localLeases !== 0 || this.#submissions.size !== 0)
      return;
    this.#state = 'destroyed';
    try {
      this.#destroy(this.value);
    } catch (error) {
      this.#destroyErrors.push(error);
      this.#onDestroyError?.(error);
    }
  }
}

function validateSubmission(submission: RHISubmission): void {
  if (
    typeof submission !== 'object' ||
    submission === null ||
    !Number.isSafeInteger(submission.id) ||
    !['pending', 'completed', 'failed', 'device-lost'].includes(submission.status) ||
    typeof submission.done?.then !== 'function'
  )
    throw new Error('Submission-retained value lease requires a valid RHISubmission.');
}
