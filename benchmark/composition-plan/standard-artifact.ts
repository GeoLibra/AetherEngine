import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  CompositionPlanCache,
  compileCompositionPlan,
  type CompositionPlanInput
} from '../../src/rendering';

const cases = [
  [1, 1, 0],
  [2, 1, 4],
  [4, 2, 4],
  [8, 4, 16]
] as const;
const results = cases.map(([views, surfaces, overlays]) => {
  const input = workload(views, surfaces, overlays);
  for (let index = 0; index < 5; index++) compileCompositionPlan(input);
  const compileSamples = samples(() => compileCompositionPlan(input));
  const cache = new CompositionPlanCache();
  cache.compile(input);
  const cacheSamples = samples(() => cache.compile(input));
  const oracle = compileCompositionPlan(input);
  if (oracle.slots.length !== views + overlays || oracle.presentOwners.size !== surfaces)
    throw new Error('Composition benchmark oracle failed.');
  return {
    views,
    surfaces,
    overlays,
    oracle: {
      hash: oracle.hash,
      slots: oracle.slots.map(({ id }) => id),
      presentOwners: [...oracle.presentOwners]
    },
    compileSamplesMs: compileSamples,
    cacheSamplesMs: cacheSamples
  };
});
const createdAt = new Date().toISOString();
const artifact = {
  schemaVersion: 1,
  suite: 'composition-plan',
  profile: 'standard',
  createdAt,
  environment: { runtime: process.version, platform: process.platform, arch: process.arch },
  protocol: { warmupCount: 5, sampleCount: 30 },
  results
};
mkdirSync('benchmark/artifacts', { recursive: true });
const path = resolve(
  'benchmark/artifacts',
  `composition-plan-standard-${createdAt.replaceAll(':', '-')}.json`
);
writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`CompositionPlan standard artifact: ${path}`);

function samples(run: () => unknown): number[] {
  return Array.from({ length: 30 }, () => {
    const start = performance.now();
    run();
    return performance.now() - start;
  });
}

function workload(viewCount: number, surfaceCount: number, overlays: number): CompositionPlanInput {
  const surfaces = Array.from({ length: surfaceCount }, (_, index) => ({
    id: `surface-${index}`,
    generation: 1,
    width: 1280,
    height: 720,
    format: 'rgba8unorm'
  }));
  const total = viewCount + overlays;
  const slots = Array.from({ length: total }, (_, index) => {
    const target = index % surfaceCount;
    const order = Math.floor(index / surfaceCount);
    return {
      id: `slot-${index}`,
      viewId: `view-${index % viewCount}`,
      targetId: `surface-${target}`,
      viewportPixels: { x: 0, y: 0, width: 1280, height: 720 },
      colorLoad: order === 0 ? ('clear' as const) : ('load' as const),
      depthLoad: 'none' as const,
      stores: { color: true, depth: false },
      order,
      present: order === Math.floor((total - 1 - target) / surfaceCount)
    };
  });
  return { id: 'standard', revision: 1, policyHash: 'fixed-policy', surfaces, slots };
}
