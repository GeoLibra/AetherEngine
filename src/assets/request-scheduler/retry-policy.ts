import type { AssetRetryDecision, AssetRetryInput, AssetRetryPolicy } from './types';

/** Plans a deterministic bounded retry time for one transient scheduler failure. */
export function planAssetRetry(
  input: AssetRetryInput,
  policy: AssetRetryPolicy
): AssetRetryDecision {
  validatePolicy(policy);
  validateInput(input);
  if (!isRetryableFailure(input.failure)) return Object.freeze({ kind: 'not-retryable' });
  if (input.completedAttempts >= policy.maximumAttempts) {
    return Object.freeze({ kind: 'attempt-limit' });
  }

  const exponentialDelay = Math.min(
    policy.maximumDelayMilliseconds,
    policy.baseDelayMilliseconds * 2 ** (input.completedAttempts - 1)
  );
  const jitter = stableJitter(input.requestKey, input.completedAttempts, policy.jitterRatio);
  const jitteredDelay = Math.min(
    policy.maximumDelayMilliseconds,
    Math.max(0, Math.round(exponentialDelay * (1 + jitter)))
  );
  const delayMilliseconds = Math.max(jitteredDelay, input.retryAfterMilliseconds ?? 0);
  const retryAtMilliseconds = input.nowMilliseconds + delayMilliseconds;
  if (!Number.isSafeInteger(retryAtMilliseconds)) {
    throw new Error('Asset retry time must be a safe integer.');
  }
  return Object.freeze({
    kind: 'retry',
    nextAttempt: input.completedAttempts + 1,
    delayMilliseconds,
    retryAtMilliseconds
  });
}

function isRetryableFailure(failure: string): boolean {
  return failure === 'offline' || failure === 'timeout' || failure === 'provider-failure';
}

function validatePolicy(policy: AssetRetryPolicy): void {
  if (
    !Number.isSafeInteger(policy.baseDelayMilliseconds) ||
    policy.baseDelayMilliseconds < 0 ||
    !Number.isSafeInteger(policy.maximumDelayMilliseconds) ||
    policy.maximumDelayMilliseconds < policy.baseDelayMilliseconds ||
    !Number.isSafeInteger(policy.maximumAttempts) ||
    policy.maximumAttempts < 1 ||
    !Number.isFinite(policy.jitterRatio) ||
    policy.jitterRatio < 0 ||
    policy.jitterRatio > 1
  ) {
    throw new Error('Asset retry policy has invalid delay, attempt, or jitter bounds.');
  }
}

function validateInput(input: AssetRetryInput): void {
  if (typeof input.requestKey !== 'string' || !input.requestKey.trim()) {
    throw new Error('Asset retry request key must be non-empty.');
  }
  if (!Number.isSafeInteger(input.completedAttempts) || input.completedAttempts < 1) {
    throw new Error('Asset retry completed attempts must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(input.nowMilliseconds) || input.nowMilliseconds < 0) {
    throw new Error('Asset retry current time must be a non-negative safe integer.');
  }
  if (
    input.retryAfterMilliseconds !== undefined &&
    (!Number.isSafeInteger(input.retryAfterMilliseconds) || input.retryAfterMilliseconds < 0)
  ) {
    throw new Error('Asset provider retry-after delay must be a non-negative safe integer.');
  }
}

function stableJitter(requestKey: string, attempt: number, ratio: number): number {
  let hash = 2166136261;
  const seed = `${requestKey}\u0000${attempt}`;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  const normalized = (hash >>> 0) / 0xffffffff;
  return (normalized * 2 - 1) * ratio;
}
