import { describe, expect, test } from 'vitest';
import { NullDevice } from '../../../src';

function createCopyCommands(device: NullDevice) {
  const source = device.createBuffer({ label: 'source', size: 16, usage: 1 });
  const destination = device.createBuffer({ label: 'destination', size: 16, usage: 1 });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(source, 0, destination, 0, 16);
  return { source, destination, commands: encoder.finish() };
}

describe('Null RHI submissions', () => {
  test('keeps referenced resources leased until manual completion', async () => {
    const device = new NullDevice({ submissionMode: 'manual' });
    const { source, commands } = createCopyCommands(device);

    const submission = device.queue.submit([commands]);
    source.dispose();

    expect(submission.status).toBe('pending');
    const pendingMetrics = device.queue.metrics();
    expect(Object.isFrozen(pendingMetrics)).toBe(true);
    expect(pendingMetrics).toEqual({
      uploadCalls: 0,
      uploadBytes: 0,
      submitted: 1,
      pending: 1,
      completed: 0,
      failed: 0,
      deviceLost: 0,
      leasedResources: 3
    });
    device.queue.completeNextForTesting();

    await expect(submission.done).resolves.toEqual({ status: 'completed' });
    expect(submission.status).toBe('completed');
    expect(device.queue.metrics()).toMatchObject({
      pending: 0,
      completed: 1,
      leasedResources: 0
    });
  });

  test('rejects resources disposed before submit and command-buffer resubmission', () => {
    const device = new NullDevice({ submissionMode: 'manual' });
    const disposed = createCopyCommands(device);
    disposed.source.dispose();

    expect(() => device.queue.submit([disposed.commands])).toThrow(
      'Resource "source" has been disposed.'
    );

    const valid = createCopyCommands(device);
    device.queue.submit([valid.commands]);
    expect(() => device.queue.submit([valid.commands])).toThrow(
      'Command buffer "command-buffer" has already been submitted.'
    );

    const duplicate = createCopyCommands(device).commands;
    expect(() => device.queue.submit([duplicate, duplicate])).toThrow(
      'Command buffer "command-buffer" has already been submitted.'
    );
    expect(() => device.queue.submit([duplicate])).not.toThrow();
  });

  test('reports deterministic failure and device-loss terminal results', async () => {
    const device = new NullDevice({ submissionMode: 'manual' });
    const failed = device.queue.submit([createCopyCommands(device).commands]);
    const failure = new Error('backend failure');
    device.queue.failNextForTesting(failure);

    await expect(failed.done).resolves.toEqual({ status: 'failed', error: failure });
    expect(Object.isFrozen(await failed.done)).toBe(true);

    const lost = device.queue.submit([createCopyCommands(device).commands]);
    device.loseForTesting('context-lost', 'queue lost');

    await expect(lost.done).resolves.toEqual({ status: 'device-lost' });
    expect(device.queue.metrics()).toMatchObject({ failed: 1, deviceLost: 1, pending: 0 });
  });

  test('auto-completes submissions by default', async () => {
    const device = new NullDevice();
    const submission = device.queue.submit([createCopyCommands(device).commands]);

    expect(submission.status).toBe('completed');
    await expect(submission.done).resolves.toEqual({ status: 'completed' });
  });
});
