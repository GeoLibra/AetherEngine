import { bench, expect } from 'vitest';
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

const profile = process.env.AETHER_BENCH_PROFILE ?? 'smoke';
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
