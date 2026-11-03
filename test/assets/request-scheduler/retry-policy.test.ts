import { describe, expect, test } from 'vitest';
import {
  AssetRequestScheduler,
  AssetRequestStage,
  AssetRequestStageFailure,
  planAssetRetry,
  type AssetRequestDemand,
  type AssetSchedulerBudget
} from '../../../src/assets/request-scheduler';

const policy = Object.freeze({
  baseDelayMilliseconds: 1_000,
  maximumDelayMilliseconds: 8_000,
  maximumAttempts: 4,
  jitterRatio: 0.2
});

const budget: AssetSchedulerBudget = Object.freeze({
  maxRequests: Object.freeze({ metadata: 1, read: 1, decode: 1, finalize: 1, upload: 1 }),
  maxInFlightBytes: Object.freeze({ metadata: 64, read: 64, decode: 64, finalize: 64, upload: 64 }),
  frameFinalizeMilliseconds: 1,
  frameUploadBytes: 64,
  frameUploadCommands: 1
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

  test('holds a transiently failed operation until its retry time, then resumes it', async () => {
    let now = 10_000;
    let attempts = 0;
    const scheduler = new AssetRequestScheduler({
      retryPolicy: { ...policy, baseDelayMilliseconds: 1_000, jitterRatio: 0 },
      nowMilliseconds: () => now
    });
    scheduler.request(demand('asset/retry-gate'));

    const first = await scheduler.execute(AssetRequestStage.Metadata, budget, {
      execute() {
        attempts += 1;
        throw new AssetRequestStageFailure('offline', 'provider is offline');
      }
    });
    expect(first[0]).toMatchObject({
      status: 'failed',
      retry: {
        kind: 'retry',
        nextAttempt: 2,
        delayMilliseconds: 1_000,
        retryAtMilliseconds: 11_000
      }
    });
    expect(scheduler.plan(AssetRequestStage.Metadata, budget).admitted).toEqual([]);
    expect(
      await scheduler.execute(AssetRequestStage.Metadata, budget, {
        execute() {
          attempts += 1;
        }
      })
    ).toEqual([]);
    expect(attempts).toBe(1);

    now = 11_000;
    expect(await scheduler.execute(AssetRequestStage.Metadata, budget, { execute() {} })).toEqual([
      expect.objectContaining({ status: 'advanced' })
    ]);
    expect(scheduler.snapshot().retries).toEqual([]);
  });

  test('keeps permanent failures suppressed and observable until the consumer cancels', async () => {
    const scheduler = new AssetRequestScheduler({
      retryPolicy: policy,
      nowMilliseconds: () => 10_000
    });
    const lease = scheduler.request(demand('asset/permanent-failure'));
    let attempts = 0;
    const first = await scheduler.execute(AssetRequestStage.Metadata, budget, {
      execute() {
        attempts += 1;
        throw new AssetRequestStageFailure('integrity', 'digest mismatch');
      }
    });

    expect(first[0]).toMatchObject({ status: 'failed', retry: { kind: 'not-retryable' } });
    expect(scheduler.plan(AssetRequestStage.Metadata, budget).admitted).toEqual([]);
    expect(scheduler.snapshot().retries).toMatchObject([
      { key: 'asset/permanent-failure', kind: 'stopped', attempt: 1 }
    ]);
    lease.cancel('discard permanently invalid asset');
    expect(scheduler.snapshot().retries).toEqual([]);
    expect(attempts).toBe(1);
  });

  test('opens a stage/failure circuit after repeated provider failures and permits one half-open probe', async () => {
    let now = 0;
    const scheduler = new AssetRequestScheduler({
      retryPolicy: {
        ...policy,
        baseDelayMilliseconds: 10,
        maximumDelayMilliseconds: 10,
        jitterRatio: 0
      },
      circuitBreaker: { failureThreshold: 2, openMilliseconds: 100 },
      nowMilliseconds: () => now
    });
    scheduler.request(demand('asset/circuit-a'));
    scheduler.request(demand('asset/circuit-b'));
    const fail = {
      execute() {
        throw new AssetRequestStageFailure('provider-failure', 'provider is unavailable');
      }
    };

    const firstFailure = await scheduler.execute(
      AssetRequestStage.Metadata,
      { ...budget, maxRequests: { ...budget.maxRequests, metadata: 1 } },
      fail
    );
    expect(firstFailure[0]?.status).toBe('failed');
    now = 10;
    const secondFailure = await scheduler.execute(
      AssetRequestStage.Metadata,
      { ...budget, maxRequests: { ...budget.maxRequests, metadata: 1 } },
      fail
    );
    expect(secondFailure[0]?.status).toBe('failed');

    expect(scheduler.snapshot().circuits).toEqual([
      expect.objectContaining({
        stage: AssetRequestStage.Metadata,
        failure: 'provider-failure',
        kind: 'open',
        openUntilMilliseconds: 110
      })
    ]);
    expect(
      scheduler.plan(AssetRequestStage.Metadata, {
        ...budget,
        maxRequests: { ...budget.maxRequests, metadata: 2 }
      }).admitted
    ).toEqual([]);
    now = 110;
    const probe = await scheduler.execute(
      AssetRequestStage.Metadata,
      { ...budget, maxRequests: { ...budget.maxRequests, metadata: 2 } },
      { execute() {} }
    );
    expect(probe).toHaveLength(1);
    expect(probe[0]?.status).toBe('advanced');
    expect(scheduler.snapshot().circuits).toEqual([]);
  });

  test('reopens a half-open circuit after an untyped probe failure', async () => {
    let now = 0;
    const scheduler = new AssetRequestScheduler({
      retryPolicy: { ...policy, jitterRatio: 0 },
      circuitBreaker: { failureThreshold: 1, openMilliseconds: 20 },
      nowMilliseconds: () => now
    });
    scheduler.request(demand('asset/circuit-probe'));
    await scheduler.execute(AssetRequestStage.Metadata, budget, {
      execute() {
        throw new AssetRequestStageFailure('provider-failure', 'offline');
      }
    });
    now = 20;
    await scheduler.execute(AssetRequestStage.Metadata, budget, {
      execute() {
        throw new Error('probe failed unexpectedly');
      }
    });

    expect(scheduler.snapshot().circuits).toEqual([
      expect.objectContaining({ kind: 'open', openUntilMilliseconds: 40, failure: 'unknown' })
    ]);
  });
});

function demand(key: string): AssetRequestDemand {
  return Object.freeze({
    key: key as AssetRequestDemand['key'],
    assetId: `asset:${key}` as AssetRequestDemand['assetId'],
    stage: AssetRequestStage.Metadata,
    consumerId: key,
    priority: Object.freeze({
      class: 'visible',
      explicit: 0,
      dependencyDepth: 0,
      age: 0,
      retryPenalty: 0
    }),
    estimated: Object.freeze({ inFlightBytes: 4 }),
    revision: 1
  });
}
