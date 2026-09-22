import { describe, expect, test } from 'vitest';
import {
  AssetRequestStage,
  AssetRequestScheduler,
  mergeAssetRequestDemands,
  planAssetStageAdmission,
  type AssetRequestDemand,
  type AssetSchedulerBudget
} from '../../../src/assets';

const BUDGET: AssetSchedulerBudget = Object.freeze({
  maxRequests: Object.freeze({ metadata: 2, read: 2, decode: 2, finalize: 2, upload: 3 }),
  maxInFlightBytes: Object.freeze({
    metadata: 100,
    read: 100,
    decode: 100,
    finalize: 100,
    upload: 100
  }),
  frameFinalizeMilliseconds: 5,
  frameUploadBytes: 80,
  frameUploadCommands: 2
});

describe('Asset request stage admission', () => {
  test('merges compatible consumers and keeps strongest urgency without mutating inputs', () => {
    const first = demand('asset/shared', 'a', { class: 'prefetch', explicit: 2, age: 1 });
    const second = demand('asset/shared', 'b', {
      class: 'visible',
      explicit: 1,
      screenContribution: 0.7,
      age: 5
    });

    const merged = mergeAssetRequestDemands([first, second]);

    expect(merged).toEqual([
      expect.objectContaining({
        key: 'asset/shared',
        consumerIds: ['a', 'b'],
        priority: expect.objectContaining({ class: 'visible', explicit: 2, age: 5 })
      })
    ]);
    expect(Object.isFrozen(merged)).toBe(true);
    expect(Object.isFrozen(merged[0]!)).toBe(true);
    expect(first.priority.class).toBe('prefetch');
  });

  test('uses stable priority ordering and never exceeds upload byte or command budgets', () => {
    const plan = planAssetStageAdmission(
      AssetRequestStage.Upload,
      [
        demand(
          'asset/background',
          'a',
          { class: 'background' },
          { uploadBytes: 40, uploadCommands: 1 }
        ),
        demand('asset/visible', 'b', { class: 'visible' }, { uploadBytes: 50, uploadCommands: 1 }),
        demand(
          'asset/interactive',
          'c',
          { class: 'interactive' },
          { uploadBytes: 30, uploadCommands: 1 }
        )
      ],
      BUDGET
    );

    expect(plan.admitted.map((item) => item.key)).toEqual(['asset/interactive', 'asset/visible']);
    expect(plan.deferred).toEqual([
      expect.objectContaining({
        request: expect.objectContaining({ key: 'asset/background' }),
        reason: 'upload-byte-limit'
      })
    ]);
    expect(plan.counters).toMatchObject({
      admittedRequests: 2,
      admittedUploadBytes: 80,
      admittedUploadCommands: 2
    });
  });

  test('classifies unsliceable oversized work and validates stage identity before admission', () => {
    const oversized = demand('asset/large', 'a', {}, { inFlightBytes: 101 });
    expect(planAssetStageAdmission(AssetRequestStage.Upload, [oversized], BUDGET).deferred).toEqual(
      [expect.objectContaining({ reason: 'request-too-large' })]
    );
    expect(() => planAssetStageAdmission(AssetRequestStage.Read, [oversized], BUDGET)).toThrow(
      'belongs to stage "upload", not "read"'
    );
  });

  test('rejects incompatible identities hidden behind one request key', () => {
    expect(() =>
      mergeAssetRequestDemands([
        demand('asset/shared', 'a'),
        { ...demand('asset/shared', 'b'), revision: 2 }
      ])
    ).toThrow('does not describe one compatible operation');
  });

  test('keeps consumer leases independent while updating merged admission facts', () => {
    const scheduler = new AssetRequestScheduler();
    const first = scheduler.request(demand('asset/shared', 'first', { class: 'background' }));
    const second = scheduler.request(demand('asset/shared', 'second', { class: 'visible' }));

    expect(scheduler.snapshot()).toMatchObject({
      activeLeases: 2,
      operations: [expect.anything()]
    });
    expect(scheduler.plan(AssetRequestStage.Upload, BUDGET).admitted[0]?.consumerIds).toEqual([
      first.id,
      second.id
    ]);

    first.updatePriority({
      class: 'interactive',
      explicit: 5,
      dependencyDepth: 0,
      age: 0,
      retryPenalty: 0
    });
    expect(scheduler.plan(AssetRequestStage.Upload, BUDGET).admitted[0]?.priority.class).toBe(
      'interactive'
    );

    first.cancel('consumer no longer needs the asset');
    expect(first.cancelled).toBe(true);
    expect(second.cancelled).toBe(false);
    expect(scheduler.snapshot()).toMatchObject({
      activeLeases: 1,
      operations: [expect.anything()]
    });
    second.cancel('last consumer released');
    expect(scheduler.snapshot()).toEqual({
      revision: 5,
      operations: [],
      activeLeases: 0,
      completedLeases: 0
    });
    expect(() => first.updatePriority(secondPriority())).toThrow('cancelled asset request lease');
  });

  test('allows only contiguous stage transitions for a pending operation', () => {
    const scheduler = new AssetRequestScheduler();
    const lease = scheduler.request({
      ...demand('asset/staged', 'consumer'),
      stage: AssetRequestStage.Metadata
    });

    expect(() => scheduler.advance(lease.key, AssetRequestStage.Decode)).toThrow(
      'must advance from "metadata" to "read"'
    );
    scheduler.advance(lease.key, AssetRequestStage.Read);
    expect(scheduler.plan(AssetRequestStage.Read, BUDGET).admitted.map((item) => item.key)).toEqual(
      ['asset/staged']
    );
    scheduler.advance(lease.key, AssetRequestStage.Decode);
    scheduler.advance(lease.key, AssetRequestStage.Finalize);
    scheduler.advance(lease.key, AssetRequestStage.Upload);
    expect(() => scheduler.advance(lease.key, AssetRequestStage.Upload)).toThrow(
      'must advance from "upload" to "terminal"'
    );
  });

  test('runs bounded executor work and suppresses cancellation-raced completion as stale', async () => {
    const scheduler = new AssetRequestScheduler();
    const staleLease = scheduler.request({
      ...demand('asset/stale', 'consumer'),
      stage: AssetRequestStage.Metadata
    });
    const stale = await scheduler.execute(AssetRequestStage.Metadata, BUDGET, {
      execute() {
        staleLease.cancel('cancelled during executor work');
      }
    });
    expect(stale).toEqual([
      expect.objectContaining({ key: 'asset/stale', stage: 'metadata', status: 'stale' })
    ]);

    const lease = scheduler.request({
      ...demand('asset/executed', 'consumer'),
      stage: AssetRequestStage.Metadata
    });
    for (const stage of [
      AssetRequestStage.Metadata,
      AssetRequestStage.Read,
      AssetRequestStage.Decode,
      AssetRequestStage.Finalize
    ] as const) {
      await expect(scheduler.execute(stage, BUDGET, { execute() {} })).resolves.toEqual([
        expect.objectContaining({ key: 'asset/executed', stage, status: 'advanced' })
      ]);
    }
    await expect(
      scheduler.execute(AssetRequestStage.Upload, BUDGET, { execute() {} })
    ).resolves.toEqual([
      expect.objectContaining({ key: 'asset/executed', stage: 'upload', status: 'completed' })
    ]);
    expect(lease.status).toBe('completed');
    expect(scheduler.snapshot()).toMatchObject({
      activeLeases: 0,
      completedLeases: 1,
      operations: []
    });
    lease.cancel('consumer releases completed result');
    expect(lease.status).toBe('cancelled');
  });
});

function secondPriority() {
  return { class: 'visible' as const, explicit: 0, dependencyDepth: 0, age: 0, retryPenalty: 0 };
}

function demand(
  key: string,
  consumerId: string,
  priority: Partial<AssetRequestDemand['priority']> = {},
  estimated: Partial<AssetRequestDemand['estimated']> = {}
): AssetRequestDemand {
  return Object.freeze({
    key: key as AssetRequestDemand['key'],
    assetId: 'asset:fixture' as AssetRequestDemand['assetId'],
    stage: AssetRequestStage.Upload,
    consumerId,
    priority: Object.freeze({
      class: 'visible',
      explicit: 0,
      dependencyDepth: 0,
      age: 0,
      retryPenalty: 0,
      ...priority
    }),
    estimated: Object.freeze({
      inFlightBytes: 10,
      uploadBytes: 10,
      uploadCommands: 1,
      ...estimated
    }),
    revision: 1
  });
}
