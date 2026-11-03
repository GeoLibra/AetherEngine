import { describe, expect, test } from 'vitest';
import {
  createAssetRequestFixture,
  scheduleAssetRequestsBucketed,
  scheduleAssetRequestsReference
} from '../../benchmark/asset-pipeline/model';
import {
  createMeshValidationFixture,
  meshFixtureReferenceOracle,
  validateMeshFixture
} from '../../benchmark/asset-pipeline/mesh-validation';
import {
  createCookDependencyChainFixture,
  invalidateCookDependencyChain
} from '../../benchmark/asset-pipeline/cook-dependency-invalidation';
import {
  createCookGarbageCollectionFixture,
  planCookGarbageCollectionFixture
} from '../../benchmark/asset-pipeline/cook-garbage-collection';
import {
  copyVFSReadReference,
  createVFSReadFixture,
  createVFSRangeFixture,
  createVFSStreamFixture,
  vfsByteChecksum
} from '../../benchmark/asset-pipeline/vfs-read';
import {
  createSyntheticGlbFixture,
  createSyntheticMeshDocument,
  executeGlbIngestBenchmark
} from '../../benchmark/asset-pipeline/gltf-ingestion';
import { cookCanonicalMeshDocument } from '../../src/assets/cooker';
import { AssetRequestStage, planAssetStageAdmission } from '../../src/assets/request-scheduler';

describe('asset pipeline benchmark semantic oracle', () => {
  test('bucketed scheduler matches the full-sort reference with merged consumers and budgets', () => {
    const demands = createAssetRequestFixture(128, 0x5eed);
    demands.push({ ...demands[7]!, consumerId: 'duplicate-consumer', explicitPriority: 99 });

    const budget = { maxRequests: 24, maxBytes: 2_000_000 } as const;
    const reference = scheduleAssetRequestsReference(demands, budget);
    const subject = scheduleAssetRequestsBucketed(demands, budget);

    expect(subject.oracleHash).toBe(reference.oracleHash);
    expect(subject.admitted).toEqual(reference.admitted);
    expect(subject.counters.duplicateConsumers).toBe(1);
    expect(subject.counters.admittedRequests).toBeLessThanOrEqual(budget.maxRequests);
    expect(subject.counters.admittedBytes).toBeLessThanOrEqual(budget.maxBytes);
  });

  test('uses stable request key as the final tie-breaker', () => {
    const base = {
      consumerId: 'consumer',
      priorityClass: 'visible' as const,
      explicitPriority: 10,
      screenContribution: 0.5,
      age: 4,
      estimatedBytes: 64
    };
    const demands = [
      { ...base, key: 'asset/z' },
      { ...base, key: 'asset/a' },
      { ...base, key: 'asset/m' }
    ];

    const result = scheduleAssetRequestsBucketed(demands, {
      maxRequests: 3,
      maxBytes: 1_000
    });

    expect(result.admitted.map((item) => item.key)).toEqual(['asset/a', 'asset/m', 'asset/z']);
  });

  test('production stage admission matches the legacy full-sort oracle for compatible upload demands', () => {
    const demands = createAssetRequestFixture(128, 0x5eed);
    demands.push({ ...demands[7]!, consumerId: 'duplicate-consumer', explicitPriority: 99 });
    const budget = { maxRequests: 24, maxBytes: 2_000_000 } as const;
    const expected = scheduleAssetRequestsReference(demands, budget);
    const result = planAssetStageAdmission(
      AssetRequestStage.Upload,
      demands.map((demand) => ({
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
      })),
      schedulerBudget(budget.maxRequests, budget.maxBytes)
    );

    expect(result.admitted.map((demand) => demand.key)).toEqual(
      expected.admitted.map((demand) => demand.key)
    );
    expect(result.counters.duplicateConsumers).toBe(1);
  });

  test('validates canonical mesh fixtures with a stable bounds oracle', () => {
    expect(validateMeshFixture(createMeshValidationFixture(6))).toBe(meshFixtureReferenceOracle(6));
  });

  test('invalidates a cook chain in dependency order with a deterministic structural oracle', () => {
    const fixture = createCookDependencyChainFixture(5);

    expect(invalidateCookDependencyChain(fixture, 2)).toEqual({
      invalidated: ['asset://node/2', 'asset://node/3', 'asset://node/4'],
      visitedNodes: 3
    });
  });

  test('retains the published half of the deterministic cook object fixture', () => {
    const result = planCookGarbageCollectionFixture(createCookGarbageCollectionFixture(6));

    expect(result.deleteHashes).toEqual(['hash-00000001', 'hash-00000003', 'hash-00000005']);
    expect(result.deleteBytes).toBe(192);
    expect(result.retainedObjects).toBe(3);
  });

  test('routes one VFS provider and preserves detached full-read bytes', async () => {
    const fixture = createVFSReadFixture(16, 1024);
    const expected = vfsByteChecksum(copyVFSReadReference(fixture.bytes));
    const result = await fixture.vfs.read({ uri: fixture.uri, expectedLength: 1024 });
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error('Expected VFS benchmark fixture success.');
    expect(result.providerId).toBe(fixture.providerId);
    expect(vfsByteChecksum(result.bytes)).toBe(expected);
    expect(fixture.dispatches()).toBe(1);
  });

  test('executes range read fixture with representation pinning', async () => {
    const fixture = createVFSRangeFixture(16 * 1024, 1024);
    const result = await fixture.vfs.readRange({
      uri: fixture.uri,
      range: fixture.range,
      expectedRevision: fixture.revision
    });
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(result.bytes.byteLength).toBe(1024);
      expect(result.totalLength).toBe(16 * 1024);
    }
  });

  test('executes stream fixture with chunk pull and completion verification', async () => {
    const fixture = createVFSStreamFixture(4096, 1024);
    const openResult = await fixture.vfs.openStream({ uri: fixture.uri });
    expect(openResult.kind).toBe('session');
    if (openResult.kind === 'session') {
      let count = 0;
      for await (const chunk of openResult.session.chunks) {
        count += chunk.bytes.byteLength;
      }
      expect(count).toBe(4096);
      const completion = await openResult.session.completion;
      expect(completion.kind).toBe('complete');
    }
  });

  test('executes deterministic synthetic GLB ingestion benchmark oracle', () => {
    const fixture = createSyntheticGlbFixture(300);
    const result = executeGlbIngestBenchmark(fixture);
    expect(result.vertexCount).toBe(300);
    expect(result.indexCount).toBe(300);
    expect(result.checksum).toBeGreaterThan(0);
  });

  test('executes deterministic mesh cooking benchmark oracle', () => {
    const meshDoc = createSyntheticMeshDocument(300);
    const result = cookCanonicalMeshDocument(meshDoc);
    expect(result.primitives[0]!.hasGeneratedTangents).toBe(true);
    expect(result.primitives[0]!.meshData.vertexCount).toBe(300);
    expect(result.totalByteLength).toBeGreaterThan(0);
  });
});

function schedulerBudget(maxRequests: number, maxBytes: number) {
  return {
    maxRequests: {
      metadata: maxRequests,
      read: maxRequests,
      decode: maxRequests,
      finalize: maxRequests,
      upload: maxRequests
    },
    maxInFlightBytes: {
      metadata: maxBytes,
      read: maxBytes,
      decode: maxBytes,
      finalize: maxBytes,
      upload: maxBytes
    },
    frameFinalizeMilliseconds: Number.MAX_SAFE_INTEGER,
    frameUploadBytes: Number.MAX_SAFE_INTEGER,
    frameUploadCommands: Number.MAX_SAFE_INTEGER
  } as const;
}
