import { describe, expect, test } from 'vitest';
import {
  RenderGraphExecutor,
  createRenderGraphExecutionPlan
} from '../../src/render-graph/executor';
import { NullDevice } from '../../src/rhi';
import { RenderGraphBuilder } from '../../src/render-graph/builder';
import {
  compileRenderGraph,
  HistoryRegistry,
  type HistoryIdentity
} from '../../src/render-graph/compiler';
import type { TextureDescriptor } from '../../src/render-graph/types';

const GRAPH_TEXTURE: TextureDescriptor = Object.freeze({
  width: 16,
  height: 16,
  depthOrArrayLayers: 1,
  mipLevelCount: 1,
  sampleCount: 1,
  format: 'rgba8unorm',
  usage: Object.freeze(['sampled', 'color-attachment'] as const)
});

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
  test('rejects a one-slot identity because readable and writable history must be distinct', () => {
    const device = new NullDevice();
    const registry = new HistoryRegistry(device);

    expect(() => registry.acquire(identity(device, { slots: 1 }))).toThrow(/at least two/i);
  });
  test('rejects an identity that names a foreign device generation', () => {
    const device = new NullDevice();
    const foreign = new NullDevice();
    const registry = new HistoryRegistry(device);

    expect(() => registry.acquire(identity(foreign))).toThrow(/device generation/i);
  });
  test('rejects execution when graph history validity disagrees with the acquired slot', () => {
    const device = new NullDevice();
    const registry = new HistoryRegistry(device);
    const historyIdentity = identity(device, {
      key: 'validity/buffer',
      slots: 2,
      descriptor: Object.freeze({
        kind: 'buffer',
        descriptor: Object.freeze({ size: 64, usage: 4 })
      })
    });
    const acquired = registry.acquire(historyIdentity);
    const graph = new RenderGraphBuilder();
    const history = graph.createBuffer(
      { size: 64, usage: ['copy-src'] },
      {
        origin: { kind: 'history', key: historyIdentity.key, slots: 2 },
        historyValid: true
      }
    );
    graph.addCopyPass({
      id: 'history-reader',
      setup(pass) {
        pass.readBuffer(history, 'copy-src');
        pass.sideEffect('read history');
        return undefined;
      },
      run() {}
    });
    const snapshot = graph.build();

    expect(() =>
      new RenderGraphExecutor().execute(
        createRenderGraphExecutionPlan(snapshot, compileRenderGraph(snapshot)),
        {
          device,
          histories: new Map([[history, { ...acquired, registry, identity: historyIdentity }]])
        }
      )
    ).toThrow(/history validity/i);
  });
  test('publishes an executed history producer and exposes pending submission state in Debug IR', async () => {
    const device = new NullDevice({ submissionMode: 'manual' });
    const registry = new HistoryRegistry(device);
    const historyIdentity = identity(device, {
      key: 'exposure/buffer',
      slots: 2,
      descriptor: Object.freeze({
        kind: 'buffer',
        descriptor: Object.freeze({ size: 64, usage: 8 })
      })
    });
    const acquired = registry.acquire(historyIdentity);
    const graph = new RenderGraphBuilder();
    const history = graph.createBuffer(
      { size: 64, usage: ['copy-dst'] },
      {
        origin: { kind: 'history', key: historyIdentity.key, slots: historyIdentity.slots },
        historyValid: acquired.readable !== undefined
      }
    );
    graph.addCopyPass({
      id: 'history-producer',
      setup(pass) {
        const output = pass.writeBuffer(history, 'copy-dst');
        pass.sideEffect('publish history');
        return { output };
      },
      run() {}
    });
    const snapshot = graph.build();
    const plan = createRenderGraphExecutionPlan(snapshot, compileRenderGraph(snapshot));

    const execution = new RenderGraphExecutor().execute(
      plan,
      {
        device,
        histories: new Map([
          [
            history,
            {
              ...acquired,
              registry,
              identity: historyIdentity
            }
          ]
        ])
      },
      { captureDebug: true }
    );

    expect(registry.debugState(historyIdentity)[0]).toMatchObject({
      producerSubmissionId: execution.submission.id,
      pendingSubmissionIds: [execution.submission.id]
    });
    expect(execution.debug?.resources[history.resourceId]?.history).toMatchObject({
      writableSlot: acquired.writable.slot,
      versionSlots: [{ version: 0 }, { version: 1, slot: acquired.writable.slot }],
      slots: expect.arrayContaining([
        expect.objectContaining({
          producerSubmissionId: execution.submission.id,
          pendingSubmissionIds: [execution.submission.id]
        })
      ])
    });
    device.queue.completeNextForTesting();
    await execution.submission.done;
    expect(registry.debugState(historyIdentity)[0]).toMatchObject({
      valid: true,
      pendingSubmissionIds: []
    });
  });
  test('publishes and rotates only after an accepted submission', async () => {
    const device = new NullDevice({ submissionMode: 'manual' });
    const registry = new HistoryRegistry(device);
    const first = registry.acquire(identity(device));

    expect(first).toMatchObject({
      readable: undefined,
      writable: { slot: 0, valid: false, invalidationReason: 'new' }
    });
    expect(registry.acquire(identity(device)).writable.slot).toBe(0);

    const submission = device.queue.submit([]);
    registry.publish(identity(device), first, submission);

    expect(registry.acquire(identity(device))).toMatchObject({
      readable: { slot: 0, valid: true },
      writable: { slot: 1, valid: false }
    });
    device.queue.completeNextForTesting();
    await submission.done;
    expect(registry.acquire(identity(device))).toMatchObject({
      readable: { slot: 0, valid: true },
      writable: { slot: 1, valid: false }
    });
  });

  test('withholds publication when real compile, encode, and submit paths reject', () => {
    const device = new NullDevice({ submissionMode: 'manual' });
    const registry = new HistoryRegistry(device);
    const acquired = registry.acquire(identity(device));

    expect(() =>
      publishAfterAcceptedSubmission(registry, identity(device), () => {
        compileRenderGraph(cyclicGraph());
        return device.queue.submit([]);
      })
    ).toThrow(/cycle/i);
    expectUnpublished(registry, identity(device), acquired);

    expect(() =>
      publishAfterAcceptedSubmission(registry, identity(device), () => {
        const encoder = device.createCommandEncoder();
        encoder.pushDebugGroup('unterminated');
        return device.queue.submit([encoder.finish()]);
      })
    ).toThrow('unclosed debug groups');
    expectUnpublished(registry, identity(device), acquired);

    expect(() =>
      publishAfterAcceptedSubmission(registry, identity(device), () => {
        const commandBuffer = device.createCommandEncoder().finish();
        commandBuffer.dispose();
        return device.queue.submit([commandBuffer]);
      })
    ).toThrow('has been disposed');
    expectUnpublished(registry, identity(device), acquired);
    expect(device.queue.metrics().submitted).toBe(0);
  });

  test('marks a completed slot valid once it becomes writable again', async () => {
    const device = new NullDevice({ submissionMode: 'manual' });
    const registry = new HistoryRegistry(device);
    const first = registry.acquire(identity(device));
    const firstSubmission = device.queue.submit([]);
    registry.publish(identity(device), first, firstSubmission);
    const second = registry.acquire(identity(device));
    const secondSubmission = device.queue.submit([]);
    registry.publish(identity(device), second, secondSubmission);

    device.queue.completeNextForTesting();
    await firstSubmission.done;
    expect(registry.acquire(identity(device))).toMatchObject({
      readable: { slot: 1, valid: true },
      writable: { slot: 0, valid: false }
    });
  });

  test('invalidates only the affected identity for resize, ABI, policy, and view reset', () => {
    const device = new NullDevice();
    const base = identity(device);
    const invalidation = (changes: Partial<HistoryIdentity>) => {
      const registry = new HistoryRegistry(device);
      registry.acquire(base);
      return registry.acquire(identity(device, changes));
    };

    expect(invalidation({ descriptor: texture(64) })).toMatchObject({
      writable: { valid: false, invalidationReason: 'resize' }
    });
    expect(invalidation({ descriptor: texture(32, 'rgba16float') })).toMatchObject({
      writable: { valid: false, invalidationReason: 'abi-changed' }
    });
    expect(invalidation({ policy: 'disabled' })).toMatchObject({
      writable: { valid: false, invalidationReason: 'policy-changed' }
    });

    const registry = new HistoryRegistry(device);
    registry.acquire(identity(device, { policy: 'disabled' }));
    registry.invalidateView('main');
    expect(registry.acquire(identity(device, { policy: 'disabled' }))).toMatchObject({
      writable: { valid: false, invalidationReason: 'view-destroyed' }
    });
  });

  test('retires only histories using the invalidated policy domain hash', () => {
    const device = new NullDevice();
    const registry = new HistoryRegistry(device);
    const affected = identity(device, { viewId: 'affected', policy: 'old-policy' });
    const unaffected = identity(device, { viewId: 'unaffected', policy: 'other-policy' });
    const oldAffected = registry.acquire(affected);
    const oldUnaffected = registry.acquire(unaffected);

    registry.invalidateFeaturePolicy({
      domain: 'history',
      previousHash: 'old-policy',
      nextHash: 'next-policy'
    });

    const nextAffected = registry.acquire(affected);
    const nextUnaffected = registry.acquire(unaffected);
    expect(nextAffected.writable).toMatchObject({
      valid: false,
      invalidationReason: 'policy-changed'
    });
    expect(nextAffected.writable.handle).not.toBe(oldAffected.writable.handle);
    expect(nextUnaffected.writable.handle).toBe(oldUnaffected.writable.handle);
  });

  test('requires an explicit shared scope and descriptor compatibility for cross-view history', () => {
    const device = new NullDevice();
    const registry = new HistoryRegistry(device);
    const left = registry.acquire(identity(device, { viewId: 'left' }));
    const right = registry.acquire(identity(device, { viewId: 'right' }));

    expect(right.writable.handle).not.toBe(left.writable.handle);

    const sharedLeft = registry.acquire(
      identity(device, { viewId: 'left', sharedScope: 'stereo-history' })
    );
    const sharedRight = registry.acquire(
      identity(device, { viewId: 'right', sharedScope: 'stereo-history' })
    );
    expect(sharedRight.writable.handle).toBe(sharedLeft.writable.handle);
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

    expect(second.writable.handle).not.toBe(first.writable.handle);
  });

  test('retires invalidated history only after every reader and producer submission is terminal', async () => {
    const device = new NullDevice({ submissionMode: 'manual' });
    const registry = new HistoryRegistry(device);
    const sharedIdentity = identity(device, { slots: 2 });
    const written = registry.acquire(sharedIdentity);
    const producer = device.queue.submit([]);
    registry.publish(sharedIdentity, written, producer);
    const reader = device.queue.submit([]);
    registry.retain(sharedIdentity, written.writable.slot, reader);

    registry.invalidate(sharedIdentity);

    expect(written.writable.handle.state).toBe('live');
    device.queue.completeNextForTesting();
    await producer.done;
    expect(written.writable.handle.state).toBe('live');
    device.queue.completeNextForTesting();
    await reader.done;
    expect(written.writable.handle.state).toBe('disposed');
  });

  test('does not treat failed or lost submissions as valid history', async () => {
    const device = new NullDevice({ submissionMode: 'manual' });
    const registry = new HistoryRegistry(device);
    const acquired = registry.acquire(identity(device));
    const failed = device.queue.submit([]);
    registry.publish(identity(device), acquired, failed);
    device.queue.failNextForTesting(new Error('failed'));
    await failed.done;

    expect(registry.acquire(identity(device))).toMatchObject({
      readable: undefined,
      writable: { slot: 1, valid: false }
    });
    const second = registry.acquire(identity(device));
    const lost = device.queue.submit([]);
    registry.publish(identity(device), second, lost);
    device.loseForTesting('unknown', 'lost for test');
    await lost.done;
    expect(second.writable.handle.state).toBe('device-lost');
  });
});

function publishAfterAcceptedSubmission(
  registry: HistoryRegistry,
  historyIdentity: HistoryIdentity,
  submit: () => ReturnType<NullDevice['queue']['submit']>
): void {
  const acquired = registry.acquire(historyIdentity);
  const submission = submit();
  registry.publish(historyIdentity, acquired, submission);
}

function expectUnpublished(
  registry: HistoryRegistry,
  historyIdentity: HistoryIdentity,
  initial: ReturnType<HistoryRegistry['acquire']>
): void {
  expect(registry.acquire(historyIdentity)).toMatchObject({
    readable: undefined,
    writable: {
      handle: initial.writable.handle,
      slot: initial.writable.slot,
      valid: false,
      invalidationReason: 'new'
    }
  });
}

function cyclicGraph() {
  const graph = new RenderGraphBuilder();
  const initial = graph.createTexture(GRAPH_TEXTURE, {
    origin: {
      kind: 'imported',
      initialState: 'sampled',
      acquire: { kind: 'external-acquire', id: 'history-compile-rejection' }
    }
  });
  let written = initial;
  graph.addRasterPass({
    id: 'write-new',
    setup(pass) {
      written = pass.writeTexture(initial, 'color-attachment');
      return written;
    },
    run() {}
  });
  graph.addCopyPass({
    id: 'read-old-and-new',
    setup(pass) {
      pass.readTexture(initial, 'sampled');
      pass.readTexture(written, 'sampled');
      pass.sideEffect('retain compile rejection cycle');
      return undefined;
    },
    run() {}
  });
  return graph.build();
}
