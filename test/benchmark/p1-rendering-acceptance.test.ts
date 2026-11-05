import { expect, test } from 'vitest';
import { observeMsaa } from '../../benchmark/p1-rendering-acceptance/msaa';
import { observeResidency } from '../../benchmark/p1-rendering-acceptance/residency';

test('records real opaque 1x/4x graphs and Null execution with exact resolve counts', async () => {
  expect((await observeMsaa(2, 1)).counters).toEqual({
    views: 2,
    sampleCount: 1,
    resolves: 0,
    textures: 4,
    renderPasses: 2,
    submissions: 1
  });
  expect((await observeMsaa(2, 4)).counters).toEqual({
    views: 2,
    sampleCount: 4,
    resolves: 2,
    textures: 6,
    renderPasses: 2,
    submissions: 1
  });
});

test('planner and owner scan agree while real leases and submissions protect residency', async () => {
  const planner = await observeResidency(16, 'planner');
  const reference = await observeResidency(16, 'owner-scan');
  expect(planner).toEqual(reference);
  expect(planner.counters).toMatchObject({
    protectedCpu: 8,
    protectedGpuLeases: 4,
    protectedGpuSubmissions: 4,
    unlistedGpuBytes: 64,
    destroyedBuffers: 17,
    finalCpuBytes: 0,
    finalGpuBytes: 0
  });
});
