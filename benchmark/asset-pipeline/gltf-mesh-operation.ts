import { adaptGltfToCanonical, parseGlbContainer } from '../../src/assets/importers/gltf';
import { cookCanonicalMeshDocument } from '../../src/assets/cooker';
import type { JobType } from '../../src/jobs';
import { NullDevice, UploadPlanner, type RHISubmission } from '../../src/rhi';
import {
  createGltfMeshBatchPipelineOperation,
  createGltfMeshPipelineOperation
} from '../../src/rendering/mesh';
import { PreparedAssetRegistry } from '../../src/rendering/world';
import { createSyntheticGlbFixture } from './gltf-ingestion';

/** Deterministic imported-bundle fixture for the scheduler's glTF mesh authority path. */
export function createGltfMeshOperationBenchmark(vertexCount: number): () => Promise<number> {
  const bundle = adaptGltfToCanonical(parseGlbContainer(createSyntheticGlbFixture(vertexCount)), {
    assetPrefix: 'gltf:benchmark'
  });
  const meshAssetId = bundle.meshes[0]!.id;
  const mesh = cookCanonicalMeshDocument(bundle.meshes[0]!, { materials: bundle.materials })
    .primitives[0]!.meshData;
  const expectedBytes =
    mesh.streams.reduce((sum, stream) => sum + stream.data.byteLength, 0) +
    (mesh.indices?.data.byteLength ?? 0);
  const capacityBytes =
    mesh.streams.reduce((sum, stream) => sum + Math.ceil(stream.data.byteLength / 16) * 16, 0) +
    (mesh.indices === undefined ? 0 : Math.ceil(mesh.indices.data.byteLength / 16) * 16);
  const variant = Object.freeze({
    assetId: meshAssetId,
    payloadVersion: 1,
    featurePolicyKey: 'benchmark',
    abiVersion: 'mesh-v1'
  });
  const request = Object.freeze({
    key: 'gltf:benchmark:mesh:0' as never,
    assetId: meshAssetId,
    revision: 1
  });

  return async () => {
    const planner = new UploadPlanner({
      capacityBytes,
      maxFrameBytes: expectedBytes,
      maxFrameCommands: mesh.streams.length + (mesh.indices === undefined ? 0 : 1),
      alignment: 16
    });
    planner.beginFrame(1);
    const device = new NullDevice();
    const prepared = new PreparedAssetRegistry();
    let submission: RHISubmission | undefined;
    const operation = createGltfMeshPipelineOperation({
      uri: 'memory:///benchmark.glb',
      decodeJob: { id: 'benchmark.glb.decode' } as JobType<Uint8Array, typeof bundle>,
      meshAssetId,
      primitiveIndex: 0,
      variant,
      planner,
      prepared,
      submitUpload: (target) => {
        submission = target.queue.submit([]);
        return submission;
      },
      onCleanupError: (error) => {
        throw error;
      }
    });
    const finalized = operation.finalize(bundle, request as never);
    const result = await operation.upload(finalized, device, request as never);
    if (result === undefined || result.status !== 'staged') {
      throw new Error('glTF mesh benchmark did not stage its upload.');
    }
    result.commit();
    if (submission === undefined) throw new Error('glTF mesh benchmark has no submission.');
    await submission.done;
    prepared.retire({ ...variant, deviceGeneration: device.generation });
    return expectedBytes;
  };
}

/** Measures one two-primitive glTF mesh commit with all writes admitted before allocation. */
export function createGltfMeshBatchOperationBenchmark(vertexCount: number): () => Promise<number> {
  const imported = adaptGltfToCanonical(parseGlbContainer(createSyntheticGlbFixture(vertexCount)), {
    assetPrefix: 'gltf:batch-benchmark'
  });
  const original = imported.meshes[0]!;
  const doubled = { ...original, primitives: [original.primitives[0]!, original.primitives[0]!] };
  const bundle = { ...imported, meshes: [doubled] };
  const cooked = cookCanonicalMeshDocument(doubled, { materials: bundle.materials });
  const expectedBytes = cooked.totalByteLength;
  const capacityBytes = cooked.primitives.reduce(
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
  const commands = cooked.primitives.reduce(
    (total, primitive) =>
      total +
      primitive.meshData.streams.length +
      (primitive.meshData.indices === undefined ? 0 : 1),
    0
  );
  const variant = Object.freeze({
    payloadVersion: 1,
    featurePolicyKey: 'benchmark',
    abiVersion: 'mesh-v1'
  });
  const request = Object.freeze({
    key: 'gltf:batch-benchmark:mesh:0' as never,
    assetId: original.id,
    revision: 1
  });

  return async () => {
    const planner = new UploadPlanner({
      capacityBytes,
      maxFrameBytes: expectedBytes,
      maxFrameCommands: commands,
      alignment: 16
    });
    planner.beginFrame(1);
    const device = new NullDevice();
    const prepared = new PreparedAssetRegistry();
    let submission: RHISubmission | undefined;
    const operation = createGltfMeshBatchPipelineOperation({
      uri: 'memory:///batch-benchmark.glb',
      decodeJob: { id: 'benchmark.batch-glb.decode' } as JobType<Uint8Array, typeof bundle>,
      meshAssetId: original.id,
      variant,
      planner,
      prepared,
      submitUpload: (target) => {
        submission = target.queue.submit([]);
        return submission;
      },
      onCleanupError: (error) => {
        throw error;
      }
    });
    const finalized = operation.finalize(bundle, request as never);
    const result = await operation.upload(finalized, device, request as never);
    if (result === undefined || result.status !== 'staged')
      throw new Error('glTF mesh batch benchmark did not stage.');
    result.commit();
    if (submission === undefined) throw new Error('glTF mesh batch benchmark has no submission.');
    await submission.done;
    if (planner.snapshot().allocatedCommands !== commands)
      throw new Error('glTF mesh batch command count mismatch.');
    for (let index = 0; index < 2; index++) {
      prepared.retire({
        ...variant,
        assetId: `${original.id}:primitive:${index}`,
        deviceGeneration: device.generation
      });
    }
    return expectedBytes;
  };
}
