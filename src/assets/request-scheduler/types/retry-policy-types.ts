/** Failures for which repeating an unchanged asset request may succeed. */
export type AssetRetryableFailure = 'offline' | 'timeout' | 'provider-failure';

/** Deterministic scheduler-owned bounds for transient asset retries. */
export interface AssetRetryPolicy {
  readonly baseDelayMilliseconds: number;
  readonly maximumDelayMilliseconds: number;
  readonly maximumAttempts: number;
  readonly jitterRatio: number;
}

/** Facts needed to decide whether and when one failed logical request may retry. */
export interface AssetRetryInput {
  readonly requestKey: string;
  readonly failure: string;
  /** Number of completed attempts, including the failure being classified. */
  readonly completedAttempts: number;
  readonly nowMilliseconds: number;
  /** Provider-specified minimum delay, when present. */
  readonly retryAfterMilliseconds?: number;
}

/** Retry scheduling result; non-transient failures and exhausted attempts are explicit. */
export type AssetRetryDecision =
  | Readonly<{
      kind: 'retry';
      nextAttempt: number;
      delayMilliseconds: number;
      retryAtMilliseconds: number;
    }>
  | Readonly<{ kind: 'not-retryable' }>
  | Readonly<{ kind: 'attempt-limit' }>;

/** Observable scheduler retry gate for a still-live logical operation. */
export type AssetRequestRetrySnapshot =
  | Readonly<{
      key: string;
      kind: 'backoff';
      attempt: number;
      retryAtMilliseconds: number;
    }>
  | Readonly<{ key: string; kind: 'stopped'; attempt: number; failure: string }>;

/** Injected retry policy and clock for deterministic scheduler admission. */
export interface AssetRequestSchedulerOptions {
  readonly retryPolicy?: AssetRetryPolicy;
  readonly nowMilliseconds?: () => number;
}
