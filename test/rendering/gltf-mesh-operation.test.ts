import { describe, expect, test } from 'vitest';
import {
  AssetPipelineExecutor,
  AssetPipelineOperationRegistry,
  AssetRequestScheduler,
  AssetRequestStage,
  NullDevice,
  PreparedAssetRegistry,
  UploadPlanner,
  adaptGltfToCanonical,
  cookCanonicalMeshDocument,
  createGltfMeshPipelineOperation,
  parseGlbContainer,
  type PreparedMesh,
  type AssetSchedulerBudget
} from '../../src';
import { createSyntheticGlbFixture } from '../../benchmark/asset-pipeline/gltf-ingestion';
import type { JobScheduler, JobType } from '../../src/jobs';
import type { VirtualFileSystem } from '../../src/assets/vfs';
import type { RHIBuffer } from '../../src/rhi/contracts';
import type { RHIBufferDescriptor } from '../../src/rhi/contracts/descriptor';

class ObservedDevice extends NullDevice {
  readonly created: RHIBuffer[] = [];
  override createBuffer(descriptor: RHIBufferDescriptor): RHIBuffer {
    const buffer = super.createBuffer(descriptor);
    this.created.push(buffer);
    return buffer;
  }
}

const budget: AssetSchedulerBudget = {
  maxRequests: { metadata: 1, read: 1, decode: 1, finalize: 1, upload: 1 },
  maxInFlightBytes: { metadata: 4096, read: 4096, decode: 4096, finalize: 4096, upload: 4096 },
  frameFinalizeMilliseconds: 100,
  frameUploadBytes: 4096,
  frameUploadCommands: 16
};

function setup() {
  const bytes = createSyntheticGlbFixture(3);
  const bundle = adaptGltfToCanonical(parseGlbContainer(bytes), { assetPrefix: 'gltf:test' });
  const meshAssetId = bundle.meshes[0]!.id;
  const cooked = cookCanonicalMeshDocument(bundle.meshes[0]!, { materials: bundle.materials });
  const mesh = cooked.primitives[0]!.meshData;
  const payloadBytes =
    mesh.streams.reduce((sum, stream) => sum + stream.data.byteLength, 0) +
    (mesh.indices?.data.byteLength ?? 0);
  const capacityBytes =
    mesh.streams.reduce((sum, stream) => sum + Math.ceil(stream.data.byteLength / 16) * 16, 0) +
    (mesh.indices === undefined ? 0 : Math.ceil(mesh.indices.data.byteLength / 16) * 16);
  const planner = new UploadPlanner({
    capacityBytes,
    maxFrameBytes: payloadBytes,
    maxFrameCommands: 16,
    alignment: 16
  });
  const device = new ObservedDevice({ submissionMode: 'manual' });
  const prepared = new PreparedAssetRegistry();
  const operations = new AssetPipelineOperationRegistry();
  const scheduler = new AssetRequestScheduler();
  const demand = {
    key: 'gltf:test:mesh:0:primitive:0' as never,
    assetId: meshAssetId,
    stage: AssetRequestStage.Metadata,
    consumerId: 'renderer',
    priority: {
      class: 'visible' as const,
      explicit: 0,
      dependencyDepth: 0,
      age: 0,
      retryPenalty: 0
    },
    estimated: {
      inFlightBytes: bytes.byteLength,
      uploadBytes: payloadBytes,
      uploadCommands: mesh.streams.length + 1
    },
    revision: 1
  };
  const lease = scheduler.request(demand);
  const request = scheduler.snapshot().operations[0]!;
  const cleanupErrors: unknown[] = [];
  operations.register(
    request,
    createGltfMeshPipelineOperation({
      uri: 'memory:///triangle.glb',
      decodeJob: { id: 'test.glb.decode' } as JobType<Uint8Array, typeof bundle>,
      meshAssetId,
      primitiveIndex: 0,
      variant: {
        assetId: meshAssetId,
        payloadVersion: 1,
        featurePolicyKey: 'test',
        abiVersion: 'mesh-v1'
      },
      planner,
      prepared,
      submitUpload: (target) => target.queue.submit([]),
      onCleanupError: (error) => {
        cleanupErrors.push(error);
      }
    })
  );
  const executor = new AssetPipelineExecutor(
    {
      read: async () => ({
        kind: 'success',
        bytes,
        resolvedUri: 'memory:///triangle.glb',
        revision: 'v1',
        contentLength: bytes.byteLength,
        providerId: 'memory' as never
      })
    } as unknown as VirtualFileSystem,
    {
      schedule: () => ({
        id: 1,
        cancel() {},
        result: Promise.resolve({
          status: 'completed' as const,
          output: bundle,
          metrics: {} as never
        })
      })
    } as unknown as JobScheduler,
    device,
    operations
  );
  return {
    planner,
    device,
    prepared,
    scheduler,
    executor,
    lease,
    request,
    cleanupErrors,
    payloadBytes
  };
}

async function advanceToUpload(fixture: ReturnType<typeof setup>) {
  for (const stage of [
    AssetRequestStage.Metadata,
    AssetRequestStage.Read,
    AssetRequestStage.Decode,
    AssetRequestStage.Finalize
  ] as const) {
    expect((await fixture.scheduler.execute(stage, budget, fixture.executor))[0]?.status).toBe(
      'advanced'
    );
  }
}

describe('glTF mesh pipeline operation', () => {
  test('defers without GPU allocation, retries, and publishes one submission-retained mesh', async () => {
    const fixture = setup();
    const { planner, device, prepared, scheduler, executor, lease } = fixture;
    await advanceToUpload(fixture);
    planner.beginFrame(1);
    const held = planner.reserve(1);
    if (held.status !== 'admitted') throw new Error('Expected ring reservation.');
    expect((await scheduler.execute(AssetRequestStage.Upload, budget, executor))[0]?.status).toBe(
      'deferred'
    );
    expect(device.queue.metrics().uploadCalls).toBe(0);
    expect(device.created).toHaveLength(0);
    planner.release(held);
    planner.beginFrame(2);
    expect((await scheduler.execute(AssetRequestStage.Upload, budget, executor))[0]?.status).toBe(
      'completed'
    );
    expect(lease.status).toBe('completed');
    const key = {
      assetId: fixture.request.assetId,
      payloadVersion: 1,
      deviceGeneration: device.generation,
      featurePolicyKey: 'test',
      abiVersion: 'mesh-v1'
    };
    const resource = prepared.acquire<PreparedMesh>(key);
    expect(resource?.prepared.value.byteLength).toBe(fixture.payloadBytes);
    resource?.dispose();
    prepared.retire(key);
    expect(device.queue.metrics().pending).toBe(1);
    device.queue.completeNextForTesting();
    await Promise.resolve();
    await Promise.resolve();
    expect(prepared.acquire(key)).toBeUndefined();
    expect(planner.snapshot().liveBytes).toBe(0);
    expect(fixture.cleanupErrors).toEqual([]);
  });

  test('cancellation after upload but before commit never publishes and waits to destroy buffers', async () => {
    const fixture = setup();
    const { planner, device, prepared, scheduler, executor, lease } = fixture;
    await advanceToUpload(fixture);
    planner.beginFrame(1);
    const pending = scheduler.execute(AssetRequestStage.Upload, budget, executor);
    lease.cancel('scene removed');
    expect((await pending)[0]?.status).toBe('stale');
    expect(device.created.length).toBeGreaterThan(0);
    expect(device.created.every((buffer) => buffer.state === 'live')).toBe(true);
    const key = {
      assetId: fixture.request.assetId,
      payloadVersion: 1,
      deviceGeneration: device.generation,
      featurePolicyKey: 'test',
      abiVersion: 'mesh-v1'
    };
    expect(prepared.acquire(key)).toBeUndefined();
    device.queue.completeNextForTesting();
    await Promise.resolve();
    await Promise.resolve();
    expect(device.created.every((buffer) => buffer.state === 'disposed')).toBe(true);
    expect(planner.snapshot().liveBytes).toBe(0);
    expect(fixture.cleanupErrors).toEqual([]);
  });

  test('duplicate prepared variant rejects publication and retires the new buffers after submission', async () => {
    const fixture = setup();
    const { planner, device, prepared, scheduler, executor, lease } = fixture;
    const key = {
      assetId: fixture.request.assetId,
      payloadVersion: 1,
      deviceGeneration: device.generation,
      featurePolicyKey: 'test',
      abiVersion: 'mesh-v1'
    };
    prepared.publish({ key, value: Object.freeze({ original: true }) });
    await advanceToUpload(fixture);
    planner.beginFrame(1);
    const result = await scheduler.execute(AssetRequestStage.Upload, budget, executor);
    expect(result[0]).toMatchObject({ status: 'failed', error: expect.any(Error) });
    expect(lease.status).toBe('active');
    const original = prepared.acquire<{ original: boolean }>(key);
    expect(original?.prepared.value.original).toBe(true);
    original?.dispose();
    expect(device.created.every((buffer) => buffer.state === 'live')).toBe(true);
    device.queue.completeNextForTesting();
    await Promise.resolve();
    await Promise.resolve();
    expect(device.created.every((buffer) => buffer.state === 'disposed')).toBe(true);
    expect(planner.snapshot().liveBytes).toBe(0);
    expect(fixture.cleanupErrors).toEqual([]);
    prepared.retire(key);
  });
});
