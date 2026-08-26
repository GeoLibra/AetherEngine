import { describe, expect, test } from 'vitest';
import { NullDevice } from '../../src/rhi';
import {
  TransientResourcePool,
  type TransientAllocationDescriptor
} from '../../src/render-graph/executor';

const BUFFER: TransientAllocationDescriptor = Object.freeze({
  kind: 'buffer',
  descriptor: Object.freeze({ size: 64, usage: 1 })
});

function surfaceTexture(targetId: symbol, generation: number, width: number, height: number) {
  return Object.freeze({
    kind: 'texture' as const,
    descriptor: Object.freeze({
      size: Object.freeze({ width, height, depthOrArrayLayers: 1 }),
      format: 'rgba8unorm',
      usage: 0x10
    }),
    surfaceScope: Object.freeze({ targetId, generation, width, height })
  });
}

describe('TransientResourcePool', () => {
  test('does not reuse an allocation before every retaining submission completes', async () => {
    const device = new NullDevice({ submissionMode: 'manual' });
    const pool = new TransientResourcePool(device);
    const first = pool.acquire(BUFFER);
    const firstSubmission = device.queue.submit([]);
    const secondSubmission = device.queue.submit([]);

    pool.release(first, [firstSubmission, secondSubmission]);

    expect(pool.acquire(BUFFER)).not.toBe(first);
    device.queue.completeNextForTesting();
    await firstSubmission.done;
    expect(pool.acquire(BUFFER)).not.toBe(first);
    device.queue.completeNextForTesting();
    await secondSubmission.done;

    expect(pool.acquire(BUFFER)).toBe(first);
  });

  test('reuses a successful retired allocation after completion', async () => {
    const device = new NullDevice({ submissionMode: 'manual' });
    const pool = new TransientResourcePool(device);
    const first = pool.acquire(BUFFER);
    const submission = device.queue.submit([]);

    pool.release(first, submission);
    device.queue.completeNextForTesting();
    await submission.done;

    expect(pool.acquire(BUFFER)).toBe(first);
  });

  test('disposes failed and device-lost retired allocations instead of reusing them', async () => {
    const device = new NullDevice({ submissionMode: 'manual' });
    const pool = new TransientResourcePool(device);
    const failed = pool.acquire(BUFFER);
    const failedSubmission = device.queue.submit([]);
    pool.release(failed, failedSubmission);
    device.queue.failNextForTesting(new Error('submit failed'));
    await failedSubmission.done;

    expect(failed.state).toBe('disposed');

    const lost = pool.acquire(BUFFER);
    const lostSubmission = device.queue.submit([]);
    pool.release(lost, lostSubmission);
    device.loseForTesting('unknown', 'lost for test');
    await lostSubmission.done;

    expect(lost.state).toBe('device-lost');
  });

  test('defers disposal until a retained lease becomes terminal', async () => {
    const device = new NullDevice({ submissionMode: 'manual' });
    const pool = new TransientResourcePool(device);
    const allocation = pool.acquire(BUFFER);
    const submission = device.queue.submit([]);

    pool.retain(allocation, submission);
    pool.dispose();

    expect(allocation.state).toBe('live');
    device.queue.completeNextForTesting();
    await submission.done;
    expect(allocation.state).toBe('disposed');
  });

  test('does not reuse surface-derived textures across target, generation, or extent identity', () => {
    const device = new NullDevice();
    const pool = new TransientResourcePool(device);
    const main = Symbol('main');
    const preview = Symbol('preview');
    const first = pool.acquire(surfaceTexture(main, 1, 4, 4));
    pool.release(first);

    const nextGeneration = pool.acquire(surfaceTexture(main, 2, 4, 4));
    expect(nextGeneration).not.toBe(first);
    pool.release(nextGeneration);

    const nextExtent = pool.acquire(surfaceTexture(main, 2, 8, 6));
    expect(nextExtent).not.toBe(nextGeneration);
    pool.release(nextExtent);

    expect(pool.acquire(surfaceTexture(preview, 2, 8, 6))).not.toBe(nextExtent);
  });

  test('retires only obsolete scopes for one surface target', () => {
    const device = new NullDevice();
    const pool = new TransientResourcePool(device);
    const main = Symbol('main');
    const preview = Symbol('preview');
    const oldMain = pool.acquire(surfaceTexture(main, 1, 4, 4));
    const currentPreview = pool.acquire(surfaceTexture(preview, 1, 4, 4));
    const fixed = pool.acquire(BUFFER);
    pool.release(oldMain);
    pool.release(currentPreview);
    pool.release(fixed);

    pool.retireSurfaceScopesBefore(main, 2);

    expect(oldMain.state).toBe('disposed');
    expect(() => pool.acquire(surfaceTexture(main, 1, 4, 4))).toThrow(
      /obsolete surface generation/i
    );
    expect(pool.acquire(surfaceTexture(preview, 1, 4, 4))).toBe(currentPreview);
    expect(pool.acquire(BUFFER)).toBe(fixed);
  });

  test('detaches retained surface identity from caller-owned scope records', () => {
    const device = new NullDevice();
    const pool = new TransientResourcePool(device);
    const targetId = Symbol('main');
    const scope = { targetId, generation: 1, width: 4, height: 4 };
    const allocation = pool.acquire({
      kind: 'texture',
      descriptor: {
        size: { width: 4, height: 4, depthOrArrayLayers: 1 },
        format: 'rgba8unorm',
        usage: 0x10
      },
      surfaceScope: scope
    });
    pool.release(allocation);

    scope.generation = 99;
    pool.retireSurfaceScopesBefore(targetId, 2);

    expect(allocation.state).toBe('disposed');
  });
});
