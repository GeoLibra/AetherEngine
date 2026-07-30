import { describe, expect, test } from 'vitest';
import { NullDevice } from '../../src/rhi';
import {
  TransientResourcePool,
  type TransientAllocationDescriptor
} from '../../src/render-graph/transient-pool';

const BUFFER: TransientAllocationDescriptor = Object.freeze({
  kind: 'buffer',
  descriptor: Object.freeze({ size: 64, usage: 1 })
});

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
});
