import { describe, expect, test } from 'vitest';

import {
  AssetRequestScheduler,
  AssetRequestStage,
  type AssetSchedulerBudget
} from '../../../src/assets';
import { NullDevice, UploadPlanner, executeBudgetedBufferWrite } from '../../../src/rhi';

const BUDGET: AssetSchedulerBudget = Object.freeze({
  maxRequests: Object.freeze({ metadata: 1, read: 1, decode: 1, finalize: 1, upload: 1 }),
  maxInFlightBytes: Object.freeze({ metadata: 64, read: 64, decode: 64, finalize: 64, upload: 64 }),
  frameFinalizeMilliseconds: 1,
  frameUploadBytes: 64,
  frameUploadCommands: 1
});

describe('budgeted asset upload execution', () => {
  test('commits an upload only after the scheduler validates surviving consumers', async () => {
    const scheduler = new AssetRequestScheduler();
    const lease = scheduler.request({
      key: 'asset/commit' as never,
      assetId: 'asset:commit' as never,
      stage: AssetRequestStage.Upload,
      consumerId: 'consumer',
      priority: { class: 'visible', explicit: 0, dependencyDepth: 0, age: 0, retryPenalty: 0 },
      estimated: { inFlightBytes: 4, uploadBytes: 4, uploadCommands: 1 },
      revision: 1
    });
    const events: string[] = [];
    const result = await scheduler.execute(AssetRequestStage.Upload, BUDGET, {
      execute: () => {
        events.push('upload');
      },
      commit: () => {
        events.push('publish');
      },
      discard: () => {
        events.push('discard');
      }
    });
    expect(result[0]?.status).toBe('completed');
    expect(lease.status).toBe('completed');
    expect(events).toEqual(['upload', 'publish']);
  });

  test('discards a completed upload candidate when its last consumer cancels in flight', async () => {
    const scheduler = new AssetRequestScheduler();
    const lease = scheduler.request({
      key: 'asset/stale' as never,
      assetId: 'asset:stale' as never,
      stage: AssetRequestStage.Upload,
      consumerId: 'consumer',
      priority: { class: 'visible', explicit: 0, dependencyDepth: 0, age: 0, retryPenalty: 0 },
      estimated: { inFlightBytes: 4, uploadBytes: 4, uploadCommands: 1 },
      revision: 1
    });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const events: string[] = [];
    const pending = scheduler.execute(AssetRequestStage.Upload, BUDGET, {
      execute: async () => {
        await gate;
        events.push('uploaded');
      },
      commit: () => {
        events.push('publish');
      },
      discard: () => {
        events.push('discard');
      }
    });
    lease.cancel('no consumers');
    finish();
    expect((await pending)[0]?.status).toBe('stale');
    expect(events).toEqual(['uploaded', 'discard']);
  });

  test('a failed publication keeps the request pending and discards the candidate', async () => {
    const scheduler = new AssetRequestScheduler();
    const lease = scheduler.request({
      key: 'asset/failed-publication' as never,
      assetId: 'asset:failed-publication' as never,
      stage: AssetRequestStage.Upload,
      consumerId: 'consumer',
      priority: { class: 'visible', explicit: 0, dependencyDepth: 0, age: 0, retryPenalty: 0 },
      estimated: { inFlightBytes: 4, uploadBytes: 4, uploadCommands: 1 },
      revision: 1
    });
    let discards = 0;
    const result = await scheduler.execute(AssetRequestStage.Upload, BUDGET, {
      execute() {},
      commit() {
        throw new Error('registry rejected variant');
      },
      discard() {
        discards += 1;
      }
    });
    expect(result[0]).toMatchObject({
      status: 'failed',
      error: new Error('registry rejected variant')
    });
    expect(lease.status).toBe('active');
    expect(scheduler.snapshot().operations).toHaveLength(1);
    expect(discards).toBe(1);
  });

  test('requires the original stateful executor for a deferred retry', async () => {
    const scheduler = new AssetRequestScheduler();
    const lease = scheduler.request({
      key: 'asset/stateful' as never,
      assetId: 'asset:stateful' as never,
      stage: AssetRequestStage.Upload,
      consumerId: 'consumer',
      priority: {
        class: 'visible',
        explicit: 0,
        dependencyDepth: 0,
        age: 0,
        retryPenalty: 0
      },
      estimated: { inFlightBytes: 4, uploadBytes: 4, uploadCommands: 1 },
      revision: 1
    });
    let discards = 0;
    const original = {
      execute: () => ({ status: 'deferred', reason: 'ring-capacity' }) as const,
      discard: () => {
        discards += 1;
      }
    };
    await scheduler.execute(AssetRequestStage.Upload, BUDGET, original);

    const replacement = await scheduler.execute(AssetRequestStage.Upload, BUDGET, {
      execute() {}
    });
    expect(replacement[0]).toMatchObject({ status: 'failed' });
    expect(replacement[0]?.error).toEqual(
      new Error('Deferred asset operation "asset/stateful" requires its original executor.')
    );
    expect(lease.status).toBe('active');
    lease.cancel('abandoned');
    expect(discards).toBe(1);
  });

  test('retries a real RHI buffer upload after the staging ring retires', async () => {
    const scheduler = new AssetRequestScheduler();
    const lease = scheduler.request({
      key: 'asset/buffer' as never,
      assetId: 'asset:buffer' as never,
      stage: AssetRequestStage.Upload,
      consumerId: 'consumer',
      priority: {
        class: 'visible',
        explicit: 0,
        dependencyDepth: 0,
        age: 0,
        retryPenalty: 0
      },
      estimated: { inFlightBytes: 4, uploadBytes: 4, uploadCommands: 1 },
      revision: 1
    });
    const device = new NullDevice({ submissionMode: 'manual' });
    const buffer = device.createBuffer({ size: 16, usage: 1 << 3 });
    const planner = new UploadPlanner({
      capacityBytes: 16,
      maxFrameBytes: 32,
      maxFrameCommands: 2,
      alignment: 16
    });
    planner.beginFrame(1);
    const held = planner.reserve(16);
    if (held.status !== 'admitted') throw new Error('Expected occupied staging ring.');
    const payload = new Uint8Array([7, 8, 9, 10]);
    let uploaded: ReturnType<typeof executeBudgetedBufferWrite> | undefined;
    const executor = {
      execute() {
        const result = executeBudgetedBufferWrite(planner, device.queue, buffer, 0, payload);
        if (result.status === 'deferred') return result;
        uploaded = result;
      }
    };

    expect(await scheduler.execute(AssetRequestStage.Upload, BUDGET, executor)).toEqual([
      expect.objectContaining({ status: 'deferred', reason: 'ring-capacity' })
    ]);
    expect(device.queue.metrics().uploadCalls).toBe(0);
    expect(lease.status).toBe('active');

    const earlierSubmission = device.queue.submit([]);
    planner.retireAfter(held, earlierSubmission);
    device.queue.completeNextForTesting();
    await earlierSubmission.done;
    await Promise.resolve();
    planner.beginFrame(2);

    expect(await scheduler.execute(AssetRequestStage.Upload, BUDGET, executor)).toEqual([
      expect.objectContaining({ status: 'completed' })
    ]);
    if (uploaded?.status !== 'written') throw new Error('Expected completed buffer upload.');
    expect(device.queue.metrics()).toMatchObject({ uploadCalls: 1, uploadBytes: 4 });
    expect(lease.status).toBe('completed');
    const finalSubmission = device.queue.submit([]);
    planner.retireAfter(uploaded.reservation, finalSubmission);
    device.queue.completeNextForTesting();
    await finalSubmission.done;
    await Promise.resolve();
    expect(planner.snapshot().liveBytes).toBe(0);
    await buffer.mapAsync(0);
    expect(Array.from(new Uint8Array(buffer.getMappedRange()).slice(0, 4))).toEqual([7, 8, 9, 10]);
    buffer.unmap();
    buffer.dispose();
  });
});
