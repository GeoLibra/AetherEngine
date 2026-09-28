import { bench, expect } from 'vitest';
import {
  createVFSReadFixture,
  copyVFSReadReference,
  vfsByteChecksum,
  createVFSRangeFixture,
  sliceVFSRangeReference,
  createVFSStreamFixture
} from './asset-pipeline/vfs-read';
import {
  createAssetRequestFixture,
  scheduleAssetRequestsBucketed,
  scheduleAssetRequestsReference
} from './asset-pipeline/model';
import {
  createMeshValidationFixture,
  meshFixtureReferenceOracle,
  validateMeshFixture
} from './asset-pipeline/mesh-validation';
import {
  createCookDependencyChainFixture,
  invalidateCookDependencyChain
} from './asset-pipeline/cook-dependency-invalidation';
import {
  createCookGarbageCollectionFixture,
  planCookGarbageCollectionFixture
} from './asset-pipeline/cook-garbage-collection';
import {
  createSyntheticGlbFixture,
  createSyntheticMeshDocument,
  executeGlbIngestBenchmark
} from './asset-pipeline/gltf-ingestion';
import { cookCanonicalMeshDocument } from '../src/assets/cooker';
import { createAssetPayloadPublicationFixture } from './asset-pipeline/asset-payload-publication';
import {
  createGltfMeshBatchOperationBenchmark,
  createGltfMeshOperationBenchmark
} from './asset-pipeline/gltf-mesh-operation';
import { validateMeshData } from '../src/geometry';
import { NullDevice, UploadPlanner } from '../src/rhi';
import { disposePreparedMesh, prepareMesh, prepareMeshBudgeted } from '../src/rendering/mesh';
import {
  AssetRequestScheduler,
  AssetRequestStage,
  planAssetStageAdmission,
  type AssetStageExecutor
} from '../src/assets/request-scheduler';

const profile = process.env.AETHER_BENCH_PROFILE ?? 'smoke';
const vfsByteLength = profile === 'nightly' ? 1_048_576 : profile === 'standard' ? 65_536 : 1_024;
for (const mountCount of [1, 16, 128]) {
  const fixture = createVFSReadFixture(mountCount, vfsByteLength);
  const expectedChecksum = vfsByteChecksum(fixture.bytes);
  bench(`raw owned copy ${vfsByteLength} bytes (${mountCount} mount comparator)`, () => {
    const result = copyVFSReadReference(fixture.bytes);
    expect(vfsByteChecksum(result)).toBe(expectedChecksum);
    expect(result.buffer).not.toBe(fixture.bytes.buffer);
  });
  bench(`VFS full read ${vfsByteLength} bytes across ${mountCount} mounts`, async () => {
    const before = fixture.dispatches();
    const result = await fixture.vfs.read({ uri: fixture.uri, expectedLength: vfsByteLength });
    if (result.kind !== 'success') throw new Error('VFS benchmark read failed.');
    expect(result.providerId).toBe(fixture.providerId);
    expect(result.contentLength).toBe(vfsByteLength);
    expect(vfsByteChecksum(result.bytes)).toBe(expectedChecksum);
    expect(fixture.dispatches() - before).toBe(1);
    result.bytes[0] = 255;
  });
}

// Range read benchmarks
const rangeChunkSize = profile === 'nightly' ? 65_536 : profile === 'standard' ? 16_384 : 1_024;
const rangePackageSize = rangeChunkSize * 16;
const rangeFixture = createVFSRangeFixture(rangePackageSize, rangeChunkSize);

bench(`raw slice ${rangeChunkSize} bytes comparator`, () => {
  const result = sliceVFSRangeReference(rangeFixture.bytes, rangeFixture.range);
  expect(result.byteLength).toBe(rangeChunkSize);
});

bench(`VFS range read ${rangeChunkSize} bytes with representation pinning`, async () => {
  const result = await rangeFixture.vfs.readRange({
    uri: rangeFixture.uri,
    range: rangeFixture.range,
    expectedRevision: rangeFixture.revision
  });
  if (result.kind !== 'success') throw new Error('Range read benchmark failed.');
  expect(result.bytes.byteLength).toBe(rangeChunkSize);
});

// Stream session benchmarks
const streamTotalBytes = profile === 'nightly' ? 65_536 : profile === 'standard' ? 16_384 : 4_096;
const streamChunkSize = profile === 'nightly' ? 4_096 : 1_024;
const streamFixture = createVFSStreamFixture(streamTotalBytes, streamChunkSize);

bench(`VFS stream pull and terminal verification (${streamTotalBytes} bytes)`, async () => {
  const openResult = await streamFixture.vfs.openStream({ uri: streamFixture.uri });
  if (openResult.kind !== 'session') throw new Error('Stream benchmark open failed.');
  let bytesPulled = 0;
  for await (const chunk of openResult.session.chunks) {
    bytesPulled += chunk.bytes.byteLength;
  }
  const completion = await openResult.session.completion;
  if (completion.kind !== 'complete') throw new Error('Stream benchmark completion failed.');
  expect(bytesPulled).toBe(streamTotalBytes);
});

const sizes =
  profile === 'nightly' ? [10_000, 100_000] : profile === 'standard' ? [10_000] : [1_000];

for (const size of sizes) {
  const fixture = createAssetRequestFixture(size, 0x5eed);
  for (let index = 0; index < Math.floor(size / 10); index++) {
    fixture.push({
      ...fixture[index]!,
      consumerId: `duplicate/${index}`,
      explicitPriority: 100
    });
  }
  const budget = Object.freeze({
    maxRequests: Math.max(1, Math.floor(size / 4)),
    maxBytes: Math.max(262_144, size * 65_536)
  });
  const expected = scheduleAssetRequestsReference(fixture, budget);

  bench(`reference full-sort schedules ${size} asset demands`, () => {
    const result = scheduleAssetRequestsReference(fixture, budget);
    expect(result.oracleHash).toBe(expected.oracleHash);
  });

  bench(`bucketed subject schedules ${size} asset demands`, () => {
    const result = scheduleAssetRequestsBucketed(fixture, budget);
    expect(result.oracleHash).toBe(expected.oracleHash);
    expect(result.counters.duplicateConsumers).toBe(Math.floor(size / 10));
  });

  const productionDemands = fixture.map((demand) => ({
    key: demand.key as never,
    assetId: `asset:benchmark/${demand.key}` as never,
    stage: AssetRequestStage.Upload,
    consumerId: demand.consumerId,
    priority: {
      class: demand.priorityClass,
      explicit: demand.explicitPriority,
      screenContribution: demand.screenContribution,
      dependencyDepth: 0,
      age: demand.age,
      retryPenalty: 0
    },
    estimated: { inFlightBytes: demand.estimatedBytes },
    revision: 1
  }));
  const productionBudget = Object.freeze({
    maxRequests: Object.freeze({
      metadata: budget.maxRequests,
      read: budget.maxRequests,
      decode: budget.maxRequests,
      finalize: budget.maxRequests,
      upload: budget.maxRequests
    }),
    maxInFlightBytes: Object.freeze({
      metadata: budget.maxBytes,
      read: budget.maxBytes,
      decode: budget.maxBytes,
      finalize: budget.maxBytes,
      upload: budget.maxBytes
    }),
    frameFinalizeMilliseconds: Number.MAX_SAFE_INTEGER,
    frameUploadBytes: Number.MAX_SAFE_INTEGER,
    frameUploadCommands: Number.MAX_SAFE_INTEGER
  });
  bench(`production stage admission schedules ${size} asset demands`, () => {
    const result = planAssetStageAdmission(
      AssetRequestStage.Upload,
      productionDemands,
      productionBudget
    );
    expect(result.admitted.map((demand) => demand.key)).toEqual(
      expected.admitted.map((demand) => demand.key)
    );
    expect(result.counters.duplicateConsumers).toBe(Math.floor(size / 10));
  });
}

const executionSizes = profile === 'nightly' ? [1_024] : profile === 'standard' ? [128] : [16];
for (const size of executionSizes) {
  const budget = Object.freeze({
    maxRequests: Object.freeze({
      metadata: size,
      read: size,
      decode: size,
      finalize: size,
      upload: size
    }),
    maxInFlightBytes: Object.freeze({
      metadata: size * 16,
      read: size * 16,
      decode: size * 16,
      finalize: size * 16,
      upload: size * 16
    }),
    frameFinalizeMilliseconds: Number.MAX_SAFE_INTEGER,
    frameUploadBytes: size * 16,
    frameUploadCommands: size
  });
  const execute = async (deferHalf: boolean) => {
    const scheduler = new AssetRequestScheduler();
    let published = 0;
    for (let index = 0; index < size; index++) {
      scheduler.request({
        key: `upload/${index}` as never,
        assetId: `asset:upload/${index}` as never,
        stage: AssetRequestStage.Upload,
        consumerId: `consumer/${index}`,
        priority: {
          class: 'visible',
          explicit: 0,
          dependencyDepth: 0,
          age: 0,
          retryPenalty: 0
        },
        estimated: { inFlightBytes: 16, uploadBytes: 16, uploadCommands: 1 },
        revision: 1
      });
    }
    const authority: AssetStageExecutor = {
      execute: (request) =>
        deferHalf && Number(request.key.slice('upload/'.length)) % 2 === 0
          ? { status: 'deferred', reason: 'ring-capacity' }
          : undefined,
      commit: () => {
        published += 1;
      }
    };
    const first = await scheduler.execute(AssetRequestStage.Upload, budget, authority);
    expect(first.filter((result) => result.status === 'deferred')).toHaveLength(
      deferHalf ? size / 2 : 0
    );
    if (deferHalf) {
      const second = await scheduler.execute(AssetRequestStage.Upload, budget, {
        execute() {},
        commit: () => {
          published += 1;
        }
      });
      expect(second).toHaveLength(size / 2);
      expect(second.every((result) => result.status === 'completed')).toBe(true);
    }
    expect(scheduler.snapshot()).toMatchObject({
      activeLeases: 0,
      completedLeases: size,
      operations: []
    });
    expect(published).toBe(size);
  };

  bench(`executes ${size} admitted upload operations without deferral`, async () => {
    await execute(false);
  });
  bench(`retries 50% of ${size} admitted upload operations next frame`, async () => {
    await execute(true);
  });
}

const meshSizes =
  profile === 'nightly' ? [3_000, 30_000] : profile === 'standard' ? [30_000] : [3_000];
for (const vertexCount of meshSizes) {
  const fixture = createMeshValidationFixture(vertexCount);
  const expected = meshFixtureReferenceOracle(vertexCount);
  bench(`validates and isolates ${vertexCount} canonical mesh vertices`, () => {
    expect(validateMeshFixture(fixture)).toBe(expected);
  });

  const mesh = validateMeshData(fixture);
  const variant = Object.freeze({
    assetId: 'mesh:benchmark',
    payloadVersion: 1,
    featurePolicyKey: 'benchmark',
    abiVersion: 'mesh-v1'
  });
  const payloadBytes =
    mesh.streams.reduce((total, stream) => total + stream.data.byteLength, 0) +
    (mesh.indices?.data.byteLength ?? 0);
  bench(`directly prepares ${vertexCount} mesh vertices baseline`, () => {
    const prepared = prepareMesh(new NullDevice(), mesh, variant);
    expect(prepared.value.byteLength).toBe(payloadBytes);
    disposePreparedMesh(prepared.value);
  });
  bench(`budget-admits and prepares ${vertexCount} mesh vertices`, () => {
    const planner = new UploadPlanner({
      capacityBytes: payloadBytes,
      maxFrameBytes: payloadBytes,
      maxFrameCommands: 2,
      alignment: 4
    });
    planner.beginFrame(1);
    const result = prepareMeshBudgeted(new NullDevice(), mesh, variant, planner);
    if (result.status !== 'prepared') throw new Error(`Mesh benchmark deferred: ${result.reason}`);
    expect(result.prepared.value.byteLength).toBe(payloadBytes);
    expect(result.reservations).toHaveLength(2);
    expect(planner.snapshot()).toMatchObject({
      allocatedBytes: payloadBytes,
      allocatedCommands: 2
    });
    for (const reservation of result.reservations) planner.release(reservation);
    disposePreparedMesh(result.prepared.value);
  });
}

const cookNodeCounts =
  profile === 'nightly' ? [10_000] : profile === 'standard' ? [10_000] : [1_000];
for (const nodeCount of cookNodeCounts) {
  const fixture = createCookDependencyChainFixture(nodeCount);
  const changedIndex = Math.floor(nodeCount / 2);
  const expectedCount = nodeCount - changedIndex;
  bench(`invalidates ${expectedCount} of ${nodeCount} cook dependency nodes`, () => {
    const result = invalidateCookDependencyChain(fixture, changedIndex);
    expect(result.visitedNodes).toBe(expectedCount);
    expect(result.invalidated[0]).toBe(`asset://node/${changedIndex}`);
    expect(result.invalidated.at(-1)).toBe(`asset://node/${nodeCount - 1}`);
  });
}

for (const objectCount of cookNodeCounts) {
  const fixture = createCookGarbageCollectionFixture(objectCount);
  bench(`plans collection for ${objectCount} cook objects`, () => {
    const result = planCookGarbageCollectionFixture(fixture);
    expect(result.deleteHashes.length).toBe(Math.floor(objectCount / 2));
    expect(result.deleteBytes).toBe(Math.floor(objectCount / 2) * 64);
  });
}

const glbVertexCounts = profile === 'nightly' ? [10_000] : profile === 'standard' ? [3_000] : [300];
for (const count of glbVertexCounts) {
  const payloadFixture = createAssetPayloadPublicationFixture(count);
  const expectedBytes = payloadFixture.source.positions.byteLength;
  bench(`raw CPU payload copy baseline (${count} mesh vertices)`, () => {
    const copy = payloadFixture.copyReference();
    expect(copy.positions.byteLength).toBe(expectedBytes);
    const checksum = copy.positions.reduce(
      (result, value) => (result * 33 + Math.round(value * 1021)) >>> 0,
      0
    );
    expect(checksum).toBe(payloadFixture.expectedChecksum);
    expect(copy.positions.buffer).not.toBe(payloadFixture.source.positions.buffer);
  });
  bench(`registers and publishes owned CPU mesh payload (${count} vertices)`, () => {
    const result = payloadFixture.publish();
    expect(result.bytes).toBe(expectedBytes);
    expect(result.checksum).toBe(payloadFixture.expectedChecksum);
    expect(result.owned).toBe(true);
  });
  const leaseCount = profile === 'nightly' ? 100_000 : profile === 'standard' ? 10_000 : 1_000;
  bench(`acquires and releases ${leaseCount} CPU payload leases (${count} vertices)`, () => {
    expect(payloadFixture.cycleLeases(leaseCount)).toEqual({
      acquisitions: leaseCount,
      releases: leaseCount,
      bytes: expectedBytes
    });
  });
}

for (const count of glbVertexCounts) {
  const glbFixture = createSyntheticGlbFixture(count);
  bench(`ingests and adapts synthetic GLB (${count} vertices)`, () => {
    const result = executeGlbIngestBenchmark(glbFixture);
    expect(result.vertexCount).toBe(count);
    expect(result.checksum).toBeGreaterThan(0);
  });

  const meshDoc = createSyntheticMeshDocument(count);
  bench(`cooks canonical mesh with tangent generation (${count} vertices)`, () => {
    const result = cookCanonicalMeshDocument(meshDoc);
    expect(result.primitives[0]!.hasGeneratedTangents).toBe(true);
    expect(result.totalByteLength).toBeGreaterThan(0);
  });

  const executeMeshOperation = createGltfMeshOperationBenchmark(count);
  bench(`cooks, budget-admits, and publishes glTF mesh (${count} vertices)`, async () => {
    expect(await executeMeshOperation()).toBeGreaterThan(0);
  });
  const executeMeshBatch = createGltfMeshBatchOperationBenchmark(count);
  bench(
    `cooks and atomically publishes two glTF mesh primitives (${count} vertices each)`,
    async () => {
      expect(await executeMeshBatch()).toBeGreaterThan(0);
    }
  );
}
