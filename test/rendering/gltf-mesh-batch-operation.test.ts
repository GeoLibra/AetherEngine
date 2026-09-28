import { describe, expect, test } from 'vitest';
import {
  NullDevice,
  PreparedAssetRegistry,
  UploadPlanner,
  adaptGltfToCanonical,
  cookCanonicalMeshDocument,
  createGltfMeshBatchPipelineOperation,
  parseGlbContainer,
  registerGltfMeshBatchPipelineOperation,
  AssetPipelineOperationRegistry,
  AssetRequestStage,
  type AssetPrioritySignals,
  type GltfImportedBundle,
  type GltfMeshBatchPipelineOperationOptions,
  type MergedAssetRequestDemand,
  type PreparedMesh
} from '../../src';
import { createSyntheticGlbFixture } from '../../benchmark/asset-pipeline/gltf-ingestion';
import type { JobType } from '../../src/jobs';
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

function fixture() {
  const imported = adaptGltfToCanonical(parseGlbContainer(createSyntheticGlbFixture(3)), {
    assetPrefix: 'gltf:batch'
  });
  const originalMesh = imported.meshes[0]!;
  const twoPrimitiveMesh = {
    ...originalMesh,
    primitives: [originalMesh.primitives[0]!, originalMesh.primitives[0]!]
  };
  const bundle: GltfImportedBundle = { ...imported, meshes: [twoPrimitiveMesh] };
  const cooked = cookCanonicalMeshDocument(twoPrimitiveMesh, { materials: bundle.materials });
  const bytes = cooked.totalByteLength;
  const aligned = cooked.primitives.reduce(
    (total, primitive) =>
      total +
      primitive.meshData.streams.reduce(
        (sum, stream) => sum + Math.ceil(stream.data.byteLength / 16) * 16,
        0
      ) +
      (primitive.meshData.indices === undefined
        ? 0
        : Math.ceil(primitive.meshData.indices.data.byteLength / 16) * 16),
    0
  );
  const device = new ObservedDevice({ submissionMode: 'manual' });
  const planner = new UploadPlanner({
    capacityBytes: aligned + 16,
    maxFrameBytes: bytes,
    maxFrameCommands: 16,
    alignment: 16
  });
  const prepared = new PreparedAssetRegistry();
  const errors: unknown[] = [];
  const variant = { payloadVersion: 1, featurePolicyKey: 'policy', abiVersion: 'mesh-v1' };
  const batchOptions: GltfMeshBatchPipelineOperationOptions = {
    uri: 'memory:///two.glb',
    decodeJob: { id: 'test.two-primitive-decode' } as JobType<Uint8Array, GltfImportedBundle>,
    meshAssetId: originalMesh.id,
    variant,
    planner,
    prepared,
    submitUpload: (target) => target.queue.submit([]),
    onCleanupError: (error) => {
      errors.push(error);
    }
  };
  const operation = createGltfMeshBatchPipelineOperation(batchOptions);
  const request = { assetId: originalMesh.id, revision: 1 } as never;
  const key = (index: number) => ({
    ...variant,
    assetId: `${originalMesh.id}:primitive:${index}`,
    deviceGeneration: device.generation
  });
  return {
    bundle,
    bytes,
    device,
    planner,
    prepared,
    errors,
    operation,
    batchOptions,
    request,
    key
  };
}

describe('multi-primitive glTF mesh operation', () => {
  test('registers only when request identity and revision match the batch operation', () => {
    const f = fixture();
    const registry = new AssetPipelineOperationRegistry();
    const registrationRequest: MergedAssetRequestDemand = {
      key: 'gltf:batch:0' as never,
      assetId: f.batchOptions.meshAssetId,
      stage: AssetRequestStage.Metadata,
      consumerIds: ['renderer'],
      priority: {
        class: 'visible',
        explicit: 0,
        dependencyDepth: 0,
        age: 0,
        retryPenalty: 0
      },
      estimated: { inFlightBytes: 1 },
      revision: f.batchOptions.variant.payloadVersion
    };
    registerGltfMeshBatchPipelineOperation(registry, registrationRequest, f.batchOptions);
    expect(registry.resolve(registrationRequest)).toBeDefined();

    expect(() =>
      registerGltfMeshBatchPipelineOperation(
        registry,
        { ...registrationRequest, revision: 2 },
        f.batchOptions
      )
    ).toThrow(/request identity\/revision/i);
  });

  test('publishes the selected canonical CPU mesh only through its validated finalize hook', () => {
    const f = fixture();
    const published: unknown[] = [];
    const operation = createGltfMeshBatchPipelineOperation({
      ...f.batchOptions,
      publishCpuPayload: (mesh, request) => published.push({ mesh, revision: request.revision })
    });
    const request = {
      key: 'gltf:batch:cpu' as never,
      assetId: f.batchOptions.meshAssetId,
      stage: AssetRequestStage.Finalize,
      consumerIds: ['renderer'],
      priority: {
        class: 'visible',
        explicit: 0,
        dependencyDepth: 0,
        age: 0,
        retryPenalty: 0
      } satisfies AssetPrioritySignals,
      estimated: { inFlightBytes: 1 },
      revision: f.batchOptions.variant.payloadVersion
    };
    const finalized = operation.finalize(f.bundle, request);

    expect(published).toEqual([]);
    operation.publishCpuPayload?.(f.bundle, finalized, request);
    expect(published).toEqual([
      { mesh: f.bundle.meshes[0], revision: f.batchOptions.variant.payloadVersion }
    ]);
  });

  test('defers the entire mesh then publishes both primitives together', async () => {
    const f = fixture();
    const finalized = f.operation.finalize(f.bundle, f.request);
    f.planner.beginFrame(1);
    const held = f.planner.reserve(1);
    if (held.status !== 'admitted') throw new Error('Expected held range.');
    expect(await f.operation.upload(finalized, f.device, f.request)).toMatchObject({
      status: 'deferred'
    });
    expect(f.device.created).toHaveLength(0);
    f.planner.release(held);
    f.planner.beginFrame(2);
    const candidate = await f.operation.upload(finalized, f.device, f.request);
    if (candidate === undefined || candidate.status !== 'staged')
      throw new Error('Expected staged batch.');
    expect(f.prepared.acquire(f.key(0))).toBeUndefined();
    expect(f.prepared.acquire(f.key(1))).toBeUndefined();
    candidate.commit();
    for (const index of [0, 1]) {
      const lease = f.prepared.acquire<PreparedMesh>(f.key(index));
      expect(lease?.prepared.value.byteLength).toBe(f.bytes / 2);
      lease?.dispose();
      f.prepared.retire(f.key(index));
    }
    expect(f.device.created.every((buffer) => buffer.state === 'live')).toBe(true);
    f.device.queue.completeNextForTesting();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.device.created.every((buffer) => buffer.state === 'disposed')).toBe(true);
    expect(f.planner.snapshot().liveBytes).toBe(0);
    expect(f.errors).toEqual([]);
  });

  test('duplicate later variant rejects the whole publication and cleans all unpublished buffers', async () => {
    const f = fixture();
    f.prepared.publish({ key: f.key(1), value: { original: true } });
    const finalized = f.operation.finalize(f.bundle, f.request);
    f.planner.beginFrame(1);
    const candidate = await f.operation.upload(finalized, f.device, f.request);
    if (candidate === undefined || candidate.status !== 'staged')
      throw new Error('Expected staged batch.');
    expect(() => candidate.commit()).toThrow(/already exists/i);
    candidate.discard();
    expect(f.prepared.acquire(f.key(0))).toBeUndefined();
    f.device.queue.completeNextForTesting();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.device.created.every((buffer) => buffer.state === 'disposed')).toBe(true);
    expect(f.errors).toEqual([]);
    f.prepared.retire(f.key(1));
  });

  test('discarding a staged batch leaves every primitive unpublished until safe cleanup', async () => {
    const f = fixture();
    const finalized = f.operation.finalize(f.bundle, f.request);
    f.planner.beginFrame(1);
    const candidate = await f.operation.upload(finalized, f.device, f.request);
    if (candidate === undefined || candidate.status !== 'staged')
      throw new Error('Expected staged batch.');
    candidate.discard();
    candidate.discard();
    expect(f.prepared.acquire(f.key(0))).toBeUndefined();
    expect(f.prepared.acquire(f.key(1))).toBeUndefined();
    expect(f.device.created.every((buffer) => buffer.state === 'live')).toBe(true);
    f.device.queue.completeNextForTesting();
    await Promise.resolve();
    await Promise.resolve();
    expect(f.device.created.every((buffer) => buffer.state === 'disposed')).toBe(true);
    expect(f.planner.snapshot().liveBytes).toBe(0);
    expect(f.errors).toEqual([]);
  });
});
