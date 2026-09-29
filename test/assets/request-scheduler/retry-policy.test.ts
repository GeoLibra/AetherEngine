import { describe, expect, test } from 'vitest';
import { planAssetRetry } from '../../../src/assets/request-scheduler';

const policy = Object.freeze({
  baseDelayMilliseconds: 1_000,
  maximumDelayMilliseconds: 8_000,
  maximumAttempts: 4,
  jitterRatio: 0.2
});

describe('asset retry policy', () => {
  test('applies deterministic bounded exponential backoff to transient failures', () => {
    const input = {
      requestKey: 'asset:tree/mesh',
      failure: 'timeout' as const,
      completedAttempts: 3,
      nowMilliseconds: 10_000
    };
    const result = planAssetRetry(input, policy);

    expect(result).toEqual(planAssetRetry(input, policy));
    expect(result).toMatchObject({
      kind: 'retry',
      nextAttempt: 4,
      retryAtMilliseconds: expect.any(Number)
    });
    if (result.kind !== 'retry') throw new Error('Expected a retry decision.');
    expect(result.delayMilliseconds).toBeGreaterThanOrEqual(3_200);
    expect(result.delayMilliseconds).toBeLessThanOrEqual(4_800);
    expect(result.retryAtMilliseconds).toBe(10_000 + result.delayMilliseconds);
  });

  test('honors provider retry-after without retrying permanent failures', () => {
    expect(
      planAssetRetry(
        {
          requestKey: 'asset:tree/texture',
          failure: 'provider-failure',
          completedAttempts: 1,
          nowMilliseconds: 5_000,
          retryAfterMilliseconds: 6_000
        },
        policy
      )
    ).toEqual({
      kind: 'retry',
      nextAttempt: 2,
      delayMilliseconds: 6_000,
      retryAtMilliseconds: 11_000
    });
    expect(
      planAssetRetry(
        {
          requestKey: 'asset:tree/texture',
          failure: 'integrity',
          completedAttempts: 1,
          nowMilliseconds: 5_000
        },
        policy
      )
    ).toEqual({ kind: 'not-retryable' });
  });

  test('stops at the attempt limit and rejects invalid policy inputs', () => {
    expect(
      planAssetRetry(
        {
          requestKey: 'asset:tree/mesh',
          failure: 'offline',
          completedAttempts: 4,
          nowMilliseconds: 0
        },
        policy
      )
    ).toEqual({ kind: 'attempt-limit' });
    expect(() =>
      planAssetRetry(
        {
          requestKey: 'asset:tree/mesh',
          failure: 'offline',
          completedAttempts: 0,
          nowMilliseconds: 0
        },
        policy
      )
    ).toThrow(/attempt/i);
    expect(() =>
      planAssetRetry(
        {
          requestKey: 'asset:tree/mesh',
          failure: 'timeout',
          completedAttempts: 1,
          nowMilliseconds: 0
        },
        { ...policy, jitterRatio: 1.5 }
      )
    ).toThrow(/jitter/i);
  });
});
