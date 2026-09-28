import { describe, expect, test } from 'vitest';

import {
  AssetPipelineExecutor,
  AssetPipelineOperationRegistry,
  AssetRequestScheduler,
  AssetRequestStage,
  AssetPayloadRegistry,
  createAssetHandle,
  defineAssetType,
  type AssetPipelineOperation,
  type AssetPipelineOperationResolver,
  type AssetSchedulerBudget
} from '../../../src/assets';
import type { JobScheduler, JobType } from '../../../src/jobs';
import type { RHIDevice } from '../../../src/rhi';
import type { VirtualFileSystem } from '../../../src/assets/vfs';

const BUDGET: AssetSchedulerBudget = {
  maxRequests: { metadata: 1, read: 1, decode: 1, finalize: 1, upload: 1 },
  maxInFlightBytes: { metadata: 1024, read: 1024, decode: 1024, finalize: 1024, upload: 1024 },
  frameFinalizeMilliseconds: 10,
  frameUploadBytes: 1024,
  frameUploadCommands: 1
};

describe('AssetPipelineExecutor', () => {
  test('publishes CPU payload only after finalize request revalidation and keeps it on upload deferral', async () => {
    interface Payload {
      readonly bytes: Uint8Array;
    }
    const payloadType = defineAssetType<Payload>('asset.scheduler-payload');
    const handle = createAssetHandle(payloadType, 'asset:mesh');
    const payloads = new AssetPayloadRegistry();
    payloads.register(handle);
    const source = new Uint8Array([1, 2, 3]);
    const operation: AssetPipelineOperation = {
      ...baseOperation(),
      publishCpuPayload(decoded, _finalized, demand) {
        payloads.publish(
          handle,
          {
            version: demand.revision,
            contentHash: 'sha256:mesh-v1',
            value: { bytes: decoded as Uint8Array },
            dependencies: []
          },
          (value) => ({ bytes: value.bytes.slice() })
        );
      },
      upload: () => ({ status: 'deferred', reason: 'ring-capacity' })
    };
    const operations = new AssetPipelineOperationRegistry();
    const initialRequest = request(AssetRequestStage.Metadata);
    operations.register(initialRequest as never, operation);
    const executor = new AssetPipelineExecutor(
      {
        read: async () => ({
          kind: 'success',
          bytes: source,
          resolvedUri: 'memory:///mesh.bin',
          revision: 'v1',
          contentLength: source.byteLength,
          providerId: 'memory' as never
        })
      } as unknown as VirtualFileSystem,
      {
        schedule: () => ({
          id: 1,
          cancel() {},
          result: Promise.resolve({
            status: 'completed' as const,
            output: source,
            metrics: {} as never
          })
        })
      } as unknown as JobScheduler,
      {} as RHIDevice,
      operations
    );
    const scheduler = new AssetRequestScheduler();
    const lease = scheduler.request({
      ...initialRequest,
      consumerId: 'renderer'
    });

    for (const stage of [
      AssetRequestStage.Metadata,
      AssetRequestStage.Read,
      AssetRequestStage.Decode,
      AssetRequestStage.Finalize
    ] as const) {
      expect((await scheduler.execute(stage, BUDGET, executor))[0]?.status).toBe('advanced');
    }
    const resolved = payloads.resolve(handle);
    expect(resolved.kind).toBe('available');
    if (resolved.kind !== 'available') throw new Error('Expected a published CPU payload.');
    expect(resolved.payload.value.bytes).toEqual(source);
    expect(resolved.payload.value.bytes).not.toBe(source);

    expect((await scheduler.execute(AssetRequestStage.Upload, BUDGET, executor))[0]).toMatchObject({
      status: 'deferred',
      reason: 'ring-capacity'
    });
    expect(lease.status).toBe('active');
    expect(payloads.availability(handle)).toEqual({ kind: 'published', version: 1 });
  });

  test('does not publish CPU payload when the final consumer cancels during finalize', async () => {
    interface Payload {
      readonly bytes: Uint8Array;
    }
    const handle = createAssetHandle(
      defineAssetType<Payload>('asset.cancelled-scheduler-payload'),
      'asset:cancelled-mesh'
    );
    const payloads = new AssetPayloadRegistry();
    payloads.register(handle);
    const operations = new AssetPipelineOperationRegistry();
    const initialRequest = request(AssetRequestStage.Metadata);
    operations.register(initialRequest as never, {
      ...baseOperation(),
      publishCpuPayload(decoded, _finalized, demand) {
        payloads.publish(
          handle,
          {
            version: demand.revision,
            contentHash: 'sha256:cancelled',
            value: { bytes: decoded as Uint8Array },
            dependencies: []
          },
          (value) => ({ bytes: value.bytes.slice() })
        );
      }
    });
    const executor = new AssetPipelineExecutor(
      {
        read: async () => ({
          kind: 'success',
          bytes: new Uint8Array([4]),
          resolvedUri: 'memory:///mesh.bin',
          revision: 'v1',
          contentLength: 1,
          providerId: 'memory' as never
        })
      } as unknown as VirtualFileSystem,
      {
        schedule: () => ({
          id: 1,
          cancel() {},
          result: Promise.resolve({
            status: 'completed' as const,
            output: new Uint8Array([4]),
            metrics: {} as never
          })
        })
      } as unknown as JobScheduler,
      {} as RHIDevice,
      operations
    );
    const scheduler = new AssetRequestScheduler();
    const lease = scheduler.request({ ...initialRequest, consumerId: 'renderer' });
    for (const stage of [
      AssetRequestStage.Metadata,
      AssetRequestStage.Read,
      AssetRequestStage.Decode
    ] as const) {
      expect((await scheduler.execute(stage, BUDGET, executor))[0]?.status).toBe('advanced');
    }

    const finalize = scheduler.execute(AssetRequestStage.Finalize, BUDGET, executor);
    lease.cancel('view closed');
    expect((await finalize)[0]?.status).toBe('stale');
    expect(payloads.availability(handle)).toEqual({ kind: 'unloaded' });
  });

  test('registers one immutable operation per request key and revision', () => {
    const operations = new AssetPipelineOperationRegistry();
    const operation = baseOperation();

    operations.register(request(AssetRequestStage.Metadata), operation);

    expect(operations.resolve(request(AssetRequestStage.Upload))).toEqual(operation);
    expect(
      operations.resolve({ ...request(AssetRequestStage.Upload), revision: 2 })
    ).toBeUndefined();
    expect(() => operations.register(request(AssetRequestStage.Read), operation)).toThrow(
      'already registered'
    );
  });

  test('routes read, decode, finalize, and upload through injected VFS, Jobs, and RHI authorities', async () => {
    const calls: string[] = [];
    const executor = new AssetPipelineExecutor(
      {
        read: async () => ({
          kind: 'success',
          bytes: new Uint8Array([1, 2, 3]),
          resolvedUri: 'memory:///mesh.bin',
          revision: 'v1',
          contentLength: 3,
          providerId: 'memory' as never
        })
      } as unknown as VirtualFileSystem,
      {
        schedule: (_type: unknown, request: { input: Uint8Array }) => ({
          id: 1,
          cancel() {},
          result: Promise.resolve({
            status: 'completed' as const,
            output: request.input.map((byte) => byte * 2),
            metrics: {} as never
          })
        })
      } as unknown as JobScheduler,
      {} as RHIDevice,
      registry({
        uri: 'memory:///mesh.bin',
        decodeJob: {} as JobType<Uint8Array, unknown>,
        finalize: (decoded) => {
          calls.push(`finalize:${(decoded as Uint8Array)[0]}`);
          return { mesh: decoded };
        },
        upload: async (finalized) => {
          calls.push(`upload:${(finalized as { mesh: Uint8Array }).mesh[2]}`);
        }
      })
    );

    for (const stage of [
      AssetRequestStage.Metadata,
      AssetRequestStage.Read,
      AssetRequestStage.Decode,
      AssetRequestStage.Finalize,
      AssetRequestStage.Upload
    ] as const) {
      await executor.execute(request(stage));
    }

    expect(calls).toEqual(['finalize:2', 'upload:6']);
    expect(executor.snapshot()).toEqual({ pendingOperations: 0, retainedBytes: 0 });
  });

  test('fails before scheduling decode when VFS returns a typed read failure', async () => {
    const executor = new AssetPipelineExecutor(
      {
        read: async () => ({
          kind: 'offline',
          code: 'offline',
          message: 'offline',
          requestedUri: 'memory:///mesh.bin'
        })
      } as unknown as VirtualFileSystem,
      {} as JobScheduler,
      {} as RHIDevice,
      registry(baseOperation())
    );

    await expect(executor.execute(request(AssetRequestStage.Read))).rejects.toThrow(
      'Asset pipeline read for "asset/key" failed: offline.'
    );
    expect(executor.snapshot()).toEqual({ pendingOperations: 0, retainedBytes: 0 });
  });

  test('retains finalized data across upload deferral and retries only the upload stage', async () => {
    const calls: string[] = [];
    let uploads = 0;
    const callerDeferral = { status: 'deferred' as const, reason: 'ring-capacity' as const };
    const executor = new AssetPipelineExecutor(
      {
        read: async () => {
          calls.push('read');
          return {
            kind: 'success',
            bytes: new Uint8Array([1, 2, 3]),
            resolvedUri: 'memory:///mesh.bin',
            revision: 'v1',
            contentLength: 3,
            providerId: 'memory' as never
          };
        }
      } as unknown as VirtualFileSystem,
      {
        schedule: () => {
          calls.push('decode');
          return {
            id: 1,
            cancel() {},
            result: Promise.resolve({
              status: 'completed' as const,
              output: { byteLength: 3 },
              metrics: {} as never
            })
          };
        }
      } as unknown as JobScheduler,
      {} as RHIDevice,
      registry({
        ...baseOperation(),
        finalize: (decoded) => {
          calls.push('finalize');
          return decoded;
        },
        upload: () => {
          uploads += 1;
          calls.push('upload');
          return uploads === 1 ? callerDeferral : undefined;
        }
      })
    );

    for (const stage of [
      AssetRequestStage.Metadata,
      AssetRequestStage.Read,
      AssetRequestStage.Decode,
      AssetRequestStage.Finalize
    ] as const) {
      await executor.execute(request(stage));
    }
    const deferral = await executor.execute(request(AssetRequestStage.Upload));
    expect(deferral).toEqual({
      status: 'deferred',
      reason: 'ring-capacity'
    });
    expect(deferral).not.toBe(callerDeferral);
    expect(Object.isFrozen(deferral)).toBe(true);
    expect(executor.snapshot()).toEqual({ pendingOperations: 1, retainedBytes: 3 });

    expect(await executor.execute(request(AssetRequestStage.Upload))).toBeUndefined();
    expect(calls).toEqual(['read', 'decode', 'finalize', 'upload', 'upload']);
    expect(executor.snapshot()).toEqual({ pendingOperations: 0, retainedBytes: 0 });
  });

  test('clears intermediates when the upload operation violates the deferral contract', async () => {
    const executor = new AssetPipelineExecutor(
      {
        read: async () => ({
          kind: 'success',
          bytes: new Uint8Array([1]),
          resolvedUri: 'memory:///mesh.bin',
          revision: 'v1',
          contentLength: 1,
          providerId: 'memory' as never
        })
      } as unknown as VirtualFileSystem,
      {
        schedule: () => ({
          id: 1,
          cancel() {},
          result: Promise.resolve({
            status: 'completed' as const,
            output: new Uint8Array([1]),
            metrics: {} as never
          })
        })
      } as unknown as JobScheduler,
      {} as RHIDevice,
      registry({
        ...baseOperation(),
        upload: () => ({ status: 'deferred', reason: 'invalid' }) as never
      })
    );
    for (const stage of [
      AssetRequestStage.Read,
      AssetRequestStage.Decode,
      AssetRequestStage.Finalize
    ] as const) {
      await executor.execute(request(stage));
    }

    await expect(executor.execute(request(AssetRequestStage.Upload))).rejects.toThrow(
      'Upload executor returned an invalid deferral result.'
    );
    expect(executor.snapshot()).toEqual({ pendingOperations: 0, retainedBytes: 0 });
  });

  test('releases finalized state when a scheduler lease cancels after upload deferral', async () => {
    const scheduler = new AssetRequestScheduler();
    const lease = scheduler.request({
      ...request(AssetRequestStage.Metadata),
      consumerId: 'consumer'
    });
    const executor = new AssetPipelineExecutor(
      {
        read: async () => ({
          kind: 'success',
          bytes: new Uint8Array([1, 2, 3]),
          resolvedUri: 'memory:///mesh.bin',
          revision: 'v1',
          contentLength: 3,
          providerId: 'memory' as never
        })
      } as unknown as VirtualFileSystem,
      {
        schedule: () => ({
          id: 1,
          cancel() {},
          result: Promise.resolve({
            status: 'completed' as const,
            output: new Uint8Array([1, 2, 3]),
            metrics: {} as never
          })
        })
      } as unknown as JobScheduler,
      {} as RHIDevice,
      registry({
        ...baseOperation(),
        upload: () => ({ status: 'deferred', reason: 'ring-capacity' })
      })
    );
    for (const stage of [
      AssetRequestStage.Metadata,
      AssetRequestStage.Read,
      AssetRequestStage.Decode,
      AssetRequestStage.Finalize
    ] as const) {
      await scheduler.execute(stage, BUDGET, executor);
    }
    expect(await scheduler.execute(AssetRequestStage.Upload, BUDGET, executor)).toEqual([
      expect.objectContaining({ status: 'deferred', reason: 'ring-capacity' })
    ]);
    expect(executor.snapshot()).toEqual({ pendingOperations: 1, retainedBytes: 3 });

    lease.cancel('consumer left');
    expect(executor.snapshot()).toEqual({ pendingOperations: 0, retainedBytes: 0 });
  });

  test('holds an upload candidate until scheduler commit and publishes it once', async () => {
    const events: string[] = [];
    const scheduler = new AssetRequestScheduler();
    const lease = scheduler.request({
      ...request(AssetRequestStage.Upload),
      consumerId: 'consumer'
    });
    const executor = new AssetPipelineExecutor(
      {
        read: async () => ({
          kind: 'success',
          bytes: new Uint8Array([1]),
          resolvedUri: 'memory:///mesh.bin',
          revision: 'v1',
          contentLength: 1,
          providerId: 'memory' as never
        })
      } as unknown as VirtualFileSystem,
      {
        schedule: () => ({
          id: 1,
          cancel() {},
          result: Promise.resolve({
            status: 'completed' as const,
            output: new Uint8Array([1]),
            metrics: {} as never
          })
        })
      } as unknown as JobScheduler,
      {} as RHIDevice,
      registry({
        ...baseOperation(),
        upload: () => ({
          status: 'staged',
          commit: () => {
            events.push('publish');
          },
          discard: () => {
            events.push('discard');
          }
        })
      })
    );
    for (const stage of [
      AssetRequestStage.Read,
      AssetRequestStage.Decode,
      AssetRequestStage.Finalize
    ] as const) {
      await executor.execute(request(stage));
    }
    expect(executor.snapshot().pendingOperations).toBe(1);
    expect((await scheduler.execute(AssetRequestStage.Upload, BUDGET, executor))[0]?.status).toBe(
      'completed'
    );
    expect(lease.status).toBe('completed');
    expect(events).toEqual(['publish']);
    expect(executor.snapshot().pendingOperations).toBe(0);
  });
});

function registry(operation: AssetPipelineOperation): AssetPipelineOperationResolver {
  return { resolve: () => operation };
}

function baseOperation(): AssetPipelineOperation {
  return {
    uri: 'memory:///mesh.bin',
    decodeJob: { id: 'asset.decode.fixture' } as JobType<Uint8Array, unknown>,
    finalize: (value) => value,
    upload: () => {}
  };
}

function request(stage: (typeof AssetRequestStage)[keyof typeof AssetRequestStage]) {
  return {
    key: 'asset/key' as never,
    assetId: 'asset:mesh' as never,
    stage,
    consumerIds: ['consumer'],
    priority: {
      class: 'visible' as const,
      explicit: 3,
      dependencyDepth: 0,
      age: 0,
      retryPenalty: 0
    },
    estimated: { inFlightBytes: 3, uploadBytes: 3, uploadCommands: 1 },
    revision: 1
  };
}
