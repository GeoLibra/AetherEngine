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
import { AssetRequestStage, planAssetStageAdmission } from '../src/assets/request-scheduler';

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

const meshSizes =
  profile === 'nightly' ? [3_000, 30_000] : profile === 'standard' ? [30_000] : [3_000];
for (const vertexCount of meshSizes) {
  const fixture = createMeshValidationFixture(vertexCount);
  const expected = meshFixtureReferenceOracle(vertexCount);
  bench(`validates and isolates ${vertexCount} canonical mesh vertices`, () => {
    expect(validateMeshFixture(fixture)).toBe(expected);
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
}
