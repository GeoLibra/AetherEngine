import { describe, expect, test } from 'vitest';

import {
  WebGL2Adapter,
  type WebGL2NativeContextLostInfo,
  type WebGL2NativeContextPort
} from '../../../src';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class SubmissionContext implements WebGL2NativeContextPort {
  readonly info = { name: 'Submission WebGL2' };
  readonly extensions = new Set<string>();
  readonly limits = {};
  readonly formats = new Map();
  readonly precision = {};
  private readonly loss = deferred<WebGL2NativeContextLostInfo>();
  readonly lost = this.loss.promise;
  readonly calls: string[] = [];
  readonly fences: Deferred<void>[] = [];
  readonly deleted: object[] = [];
  createSubmissionFence?: () => Promise<void>;

  constructor(withFence = true) {
    if (withFence) {
      this.createSubmissionFence = () => {
          this.calls.push('fence');
          const fence = deferred<void>();
          this.fences.push(fence);
          return fence.promise;
      };
    }
  }

  createBuffer(): object {
    this.calls.push('createBuffer');
    return {};
  }
  createTexture(): object {
    this.calls.push('createTexture');
    return {};
  }
  deleteBuffer(handle: object): void {
    this.deleted.push(handle);
  }
  deleteTexture(handle: object): void {
    this.deleted.push(handle);
  }
  writeBuffer(): void {
    this.calls.push('writeBuffer');
  }
  copyBufferToBuffer(): void {
    this.calls.push('copyBufferToBuffer');
  }
  beginRenderPass(): void {
    this.calls.push('beginRenderPass');
  }
  endRenderPass(): void {
    this.calls.push('endRenderPass');
  }
  lose(info: WebGL2NativeContextLostInfo): void {
    this.loss.resolve(info);
  }
}

async function createDevice(native = new SubmissionContext()) {
  const device = await new WebGL2Adapter(native).requestDevice({
    requiredFeatures: [],
    optionalFeatures: []
  });
  return { device, native };
}

function recordCopy(device: Awaited<ReturnType<typeof createDevice>>['device']) {
  const source = device.createBuffer({ label: 'source', size: 16, usage: 1 });
  const destination = device.createBuffer({ label: 'destination', size: 16, usage: 2 });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(source, 0, destination, 0, 16);
  return { source, destination, commands: encoder.finish() };
}

describe('WebGL2 submission epochs', () => {
  test('prevalidates a batch, replays it once, and creates one fence', async () => {
    const { device, native } = await createDevice();
    const first = recordCopy(device);
    const second = recordCopy(device);
    native.calls.length = 0;

    const submission = device.queue.submit([first.commands, second.commands]);

    expect(submission.status).toBe('pending');
    expect(native.calls).toEqual(['copyBufferToBuffer', 'copyBufferToBuffer', 'fence']);
    expect(device.queue.metrics()).toMatchObject({
      submitted: 1,
      pending: 1,
      completed: 0,
      leasedResources: 6,
      submissionEpochs: 1
    });
    native.fences[0]?.resolve(undefined);
    await expect(submission.done).resolves.toEqual({ status: 'completed' });
    expect(device.queue.metrics()).toMatchObject({ pending: 0, completed: 1, leasedResources: 0 });
  });

  test('rejects duplicate and disposed resources before replay or mutation', async () => {
    const { device, native } = await createDevice();
    const duplicate = recordCopy(device);
    native.calls.length = 0;

    expect(() => device.queue.submit([duplicate.commands, duplicate.commands])).toThrow(
      'already been submitted'
    );
    expect(native.calls).toEqual([]);
    expect(() => device.queue.submit([duplicate.commands])).not.toThrow();

    const disposed = recordCopy(device);
    disposed.source.dispose();
    native.calls.length = 0;
    expect(() => device.queue.submit([disposed.commands])).toThrow('has been disposed');
    expect(native.calls).toEqual([]);
  });

  test('defers native deletion until the fence settles and reports failure', async () => {
    const { device, native } = await createDevice();
    const recorded = recordCopy(device);
    const submission = device.queue.submit([recorded.commands]);
    recorded.source.dispose();
    recorded.destination.dispose();
    expect(native.deleted).toHaveLength(0);
    const failure = new Error('fence failed');
    native.fences[0]?.reject(failure);

    await expect(submission.done).resolves.toEqual({ status: 'failed', error: failure });
    expect(native.deleted).toHaveLength(2);
    expect(device.queue.metrics()).toMatchObject({ failed: 1, pending: 0 });
  });

  test('uses conservative completion without a fence and settles loss once', async () => {
    const conservative = await createDevice(new SubmissionContext(false));
    const completed = conservative.device.queue.submit([recordCopy(conservative.device).commands]);
    await expect(completed.done).resolves.toEqual({ status: 'completed' });

    const fenced = await createDevice();
    const lost = fenced.device.queue.submit([recordCopy(fenced.device).commands]);
    fenced.native.lose({ reason: 'context-lost', message: 'lost during submit' });
    await fenced.device.lost;
    await expect(lost.done).resolves.toEqual({ status: 'device-lost' });
    fenced.native.fences[0]?.resolve(undefined);
    await Promise.resolve();
    expect(fenced.device.queue.metrics()).toMatchObject({
      deviceLost: 1,
      completed: 0,
      pending: 0
    });
  });

  test('counts upload bytes and native upload calls', async () => {
    const { device, native } = await createDevice();
    const buffer = device.createBuffer({ size: 16, usage: 2 });
    native.calls.length = 0;

    device.queue.writeBuffer(buffer, 4, new Uint8Array([1, 2, 3, 4]));

    expect(native.calls).toEqual(['writeBuffer']);
    expect(device.queue.metrics()).toMatchObject({ uploadBytes: 4, glCalls: 1 });
  });

  test('retains a texture behind an attachment view until completion', async () => {
    const { device, native } = await createDevice();
    const texture = device.createTexture({ size: [4, 4], format: 'rgba8unorm', usage: 16 });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view: texture.createView(), loadOp: 'load', storeOp: 'store' }]
    });
    pass.end();
    const submission = device.queue.submit([encoder.finish()]);

    texture.dispose();
    expect(native.deleted).toHaveLength(0);
    native.fences[0]?.resolve(undefined);
    await submission.done;
    expect(native.deleted).toHaveLength(1);
  });
});
