import { describe, expect, test } from 'vitest';

import {
  AssetPipelineExecutor,
  AssetPipelineOperationRegistry,
  AssetRequestStage,
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
