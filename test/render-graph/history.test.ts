import { describe, expect, test } from 'vitest';
import { NullDevice } from '../../src/rhi';
import { HistoryRegistry, type HistoryIdentity } from '../../src/render-graph/history';

const texture = (width = 32, format = 'rgba8unorm') =>
  Object.freeze({
    kind: 'texture' as const,
    descriptor: Object.freeze({
      size: Object.freeze({ width, height: 16, depthOrArrayLayers: 1 }),
      format,
      usage: 16,
      sampleCount: 1
    })
  });

function identity(device: NullDevice, changes: Partial<HistoryIdentity> = {}): HistoryIdentity {
  return {
    deviceGeneration: device.generation,
    viewId: 'main',
    key: 'taa/color',
    descriptor: texture(),
    slots: 2,
    abi: 'taa-v1',
    policy: 'enabled',
    ...changes
  };
}

describe('HistoryRegistry', () => {
  test('publishes and rotates only after an accepted submission', async () => {
    const device = new NullDevice({ submissionMode: 'manual' });
    const registry = new HistoryRegistry(device);
    const first = registry.acquire(identity(device));

    expect(first).toMatchObject({ slot: 0, valid: false, invalidationReason: 'new' });
    expect(registry.acquire(identity(device)).slot).toBe(0);

    const submission = device.queue.submit([]);
    registry.publish(identity(device), first.slot, submission);

    expect(registry.acquire(identity(device))).toMatchObject({ slot: 1, valid: false });
    device.queue.completeNextForTesting();
    await submission.done;
    expect(registry.acquire(identity(device))).toMatchObject({ slot: 1, valid: false });
  });

  test('does not rotate when compile, encode, or submit rejects before publication', () => {
    const device = new NullDevice({ submissionMode: 'manual' });
    const registry = new HistoryRegistry(device);
    const acquired = registry.acquire(identity(device));

    for (const stage of ['compile', 'encode', 'submit']) {
      expect(() => {
        throw new Error(`${stage} rejected`);
      }).toThrow(`${stage} rejected`);
      expect(registry.acquire(identity(device))).toMatchObject({
        slot: acquired.slot,
        valid: false
      });
    }
  });

  test('marks a completed slot valid once it becomes writable again', async () => {
    const device = new NullDevice({ submissionMode: 'manual' });
    const registry = new HistoryRegistry(device);
    const first = registry.acquire(identity(device));
    const firstSubmission = device.queue.submit([]);
    registry.publish(identity(device), first.slot, firstSubmission);
    const second = registry.acquire(identity(device));
    const secondSubmission = device.queue.submit([]);
    registry.publish(identity(device), second.slot, secondSubmission);

    device.queue.completeNextForTesting();
    await firstSubmission.done;
    expect(registry.acquire(identity(device))).toMatchObject({ slot: 0, valid: true });
  });

  test('invalidates only the affected identity for generation, resize, ABI, policy, and view reset', () => {
    const device = new NullDevice();
    const base = identity(device);
    const invalidation = (changes: Partial<HistoryIdentity>) => {
      const registry = new HistoryRegistry(device);
      registry.acquire(base);
      return registry.acquire(identity(device, changes));
    };

    expect(invalidation({ deviceGeneration: device.generation + 1 })).toMatchObject({
      valid: false,
      invalidationReason: 'generation-changed'
    });
    expect(invalidation({ descriptor: texture(64) })).toMatchObject({
      valid: false,
      invalidationReason: 'resize'
    });
    expect(invalidation({ descriptor: texture(32, 'rgba16float') })).toMatchObject({
      valid: false,
      invalidationReason: 'abi-changed'
    });
    expect(invalidation({ policy: 'disabled' })).toMatchObject({
      valid: false,
      invalidationReason: 'policy-changed'
    });

    const registry = new HistoryRegistry(device);
    registry.acquire(identity(device, { policy: 'disabled' }));
    registry.invalidateView('main');
    expect(registry.acquire(identity(device, { policy: 'disabled' }))).toMatchObject({
      valid: false,
      invalidationReason: 'view-destroyed'
    });
  });

  test('requires an explicit shared scope and descriptor compatibility for cross-view history', () => {
    const device = new NullDevice();
    const registry = new HistoryRegistry(device);
    const left = registry.acquire(identity(device, { viewId: 'left' }));
    const right = registry.acquire(identity(device, { viewId: 'right' }));

    expect(right.handle).not.toBe(left.handle);

    const sharedLeft = registry.acquire(
      identity(device, { viewId: 'left', sharedScope: 'stereo-history' })
    );
    const sharedRight = registry.acquire(
      identity(device, { viewId: 'right', sharedScope: 'stereo-history' })
    );
    expect(sharedRight.handle).toBe(sharedLeft.handle);
    expect(() =>
      registry.acquire(
        identity(device, {
          viewId: 'right',
          sharedScope: 'stereo-history',
          descriptor: texture(64)
        })
      )
    ).toThrow('incompatible');
    expect(() => registry.acquire(identity(device, { sharedScope: '' }))).toThrow('sharedScope');
  });

  test('keeps structurally distinct view and key identities separate', () => {
    const device = new NullDevice();
    const registry = new HistoryRegistry(device);
    const first = registry.acquire(identity(device, { viewId: 'alpha:key:beta', key: 'gamma' }));
    const second = registry.acquire(identity(device, { viewId: 'alpha', key: 'beta:key:gamma' }));

    expect(second.handle).not.toBe(first.handle);
  });

  test('retires invalidated history only after every reader and producer submission is terminal', async () => {
    const device = new NullDevice({ submissionMode: 'manual' });
    const registry = new HistoryRegistry(device);
    const sharedIdentity = identity(device, { slots: 1 });
    const written = registry.acquire(sharedIdentity);
    const producer = device.queue.submit([]);
    registry.publish(sharedIdentity, written.slot, producer);
    const reader = device.queue.submit([]);
    registry.retain(sharedIdentity, written.slot, reader);

    registry.invalidate(sharedIdentity);

    expect(written.handle.state).toBe('live');
    device.queue.completeNextForTesting();
    await producer.done;
    expect(written.handle.state).toBe('live');
    device.queue.completeNextForTesting();
    await reader.done;
    expect(written.handle.state).toBe('disposed');
  });

  test('does not treat failed or lost submissions as valid history', async () => {
    const device = new NullDevice({ submissionMode: 'manual' });
    const registry = new HistoryRegistry(device);
    const acquired = registry.acquire(identity(device));
    const failed = device.queue.submit([]);
    registry.publish(identity(device), acquired.slot, failed);
    device.queue.failNextForTesting(new Error('failed'));
    await failed.done;

    expect(registry.acquire(identity(device))).toMatchObject({ slot: 1, valid: false });
    const second = registry.acquire(identity(device));
    const lost = device.queue.submit([]);
    registry.publish(identity(device), second.slot, lost);
    device.loseForTesting('unknown', 'lost for test');
    await lost.done;
    expect(second.handle.state).toBe('device-lost');
  });
});
