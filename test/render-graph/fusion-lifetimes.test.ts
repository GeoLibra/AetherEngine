/**
 * Tests for physical lifetime widening in fused raster pass groups.
 *
 * Verifies that the compiler widens resource lifetimes within fused groups to
 * [group.start, group.end] in compiled schedule coordinates, ensuring that transient
 * resources used in consecutive member passes of the same physical group never share
 * the same physical memory allocation via aliasing.
 */

import { describe, expect, test } from 'vitest';
import { RenderGraphBuilder } from '../../src/render-graph/builder';
import {
  analyzeResourceLifetimes,
  compileRenderGraph,
  planResourceAliases
} from '../../src/render-graph/compiler';
import { partitionRasterGroups } from '../../src/render-graph/compiler/fusion';
import type { BufferDescriptor, TextureDescriptor } from '../../src/render-graph/types';

const COLOR_DESC: TextureDescriptor = Object.freeze({
  width: 64,
  height: 64,
  depthOrArrayLayers: 1,
  mipLevelCount: 1,
  sampleCount: 1,
  format: 'rgba8unorm',
  usage: Object.freeze(['color-attachment', 'sampled'] as const)
});

const BUFFER_DESC: BufferDescriptor = Object.freeze({
  size: 256,
  usage: Object.freeze(['storage-read', 'storage-write', 'copy-src', 'copy-dst'] as const)
});

describe('fusion physical lifetime widening', () => {
  test('widens member resource lifetimes to entire physical group span', () => {
    const builder = new RenderGraphBuilder();
    const color = builder.createTexture(COLOR_DESC);
    const bufA = builder.createBuffer(BUFFER_DESC);
    const bufB = builder.createBuffer(BUFFER_DESC);

    let currentColor = color;

    // Pass 0: member A writes bufA
    builder.addRasterPass({
      id: 'pass-a',
      setup(pass) {
        currentColor = pass.colorAttachment(0, currentColor, {
          load: 'clear',
          store: 'auto'
        });
        pass.writeBuffer(bufA, 'storage-write');
        pass.sideEffect('member a');
        return {};
      },
      run() {}
    });

    // Pass 1: member B writes bufB
    builder.addRasterPass({
      id: 'pass-b',
      setup(pass) {
        currentColor = pass.colorAttachment(0, currentColor, {
          load: 'load',
          store: 'store'
        });
        pass.writeBuffer(bufB, 'storage-write');
        pass.sideEffect('member b');
        return {};
      },
      run() {}
    });

    const snapshot = builder.build();
    const compiled = compileRenderGraph(snapshot);
    const { groups } = partitionRasterGroups(snapshot, compiled);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.retainedPassIndices).toEqual([0, 1]);

    // Lifetimes WITHOUT raster groups: bufA is [0, 0], bufB is [1, 1]
    const unwidened = analyzeResourceLifetimes(snapshot, compiled);
    const unwidenedBufA = unwidened.find((l) => l.resourceId === bufA.resourceId);
    const unwidenedBufB = unwidened.find((l) => l.resourceId === bufB.resourceId);
    expect(unwidenedBufA?.firstUse).toBe(0);
    expect(unwidenedBufA?.lastUse).toBe(0);
    expect(unwidenedBufB?.firstUse).toBe(1);
    expect(unwidenedBufB?.lastUse).toBe(1);

    // Lifetimes WITH raster groups: both widened to [0, 1]
    const widened = analyzeResourceLifetimes(snapshot, compiled, groups);
    const widenedBufA = widened.find((l) => l.resourceId === bufA.resourceId);
    const widenedBufB = widened.find((l) => l.resourceId === bufB.resourceId);
    expect(widenedBufA?.firstUse).toBe(0);
    expect(widenedBufA?.lastUse).toBe(1);
    expect(widenedBufB?.firstUse).toBe(0);
    expect(widenedBufB?.lastUse).toBe(1);
  });

  test('prevents transient alias reuse between consecutive passes of the same fused group', () => {
    const builder = new RenderGraphBuilder();
    const color = builder.createTexture(COLOR_DESC);
    const bufA = builder.createBuffer(BUFFER_DESC);
    const bufB = builder.createBuffer(BUFFER_DESC);

    let currentColor = color;

    builder.addRasterPass({
      id: 'pass-a',
      setup(pass) {
        currentColor = pass.colorAttachment(0, currentColor, {
          load: 'clear',
          store: 'auto'
        });
        pass.writeBuffer(bufA, 'storage-write');
        pass.sideEffect('member a');
        return {};
      },
      run() {}
    });

    builder.addRasterPass({
      id: 'pass-b',
      setup(pass) {
        currentColor = pass.colorAttachment(0, currentColor, {
          load: 'load',
          store: 'store'
        });
        pass.writeBuffer(bufB, 'storage-write');
        pass.sideEffect('member b');
        return {};
      },
      run() {}
    });

    const snapshot = builder.build();
    const compiled = compileRenderGraph(snapshot);
    const { groups } = partitionRasterGroups(snapshot, compiled);

    // Without fusion awareness: disjoint lifetimes allow bufA and bufB to share allocationId 0
    const unwidenedLifetimes = analyzeResourceLifetimes(snapshot, compiled);
    const unwidenedPlan = planResourceAliases(snapshot, unwidenedLifetimes);
    const unwidenedAllocA = unwidenedPlan.decisions.find(
      (d) => d.resourceId === bufA.resourceId
    )?.allocationId;
    const unwidenedAllocB = unwidenedPlan.decisions.find(
      (d) => d.resourceId === bufB.resourceId
    )?.allocationId;
    expect(unwidenedAllocA).toBe(unwidenedAllocB); // Same allocation!

    // With fusion awareness: widened lifetimes overlap, requiring separate allocations
    const widenedLifetimes = analyzeResourceLifetimes(snapshot, compiled, groups);
    const widenedPlan = planResourceAliases(snapshot, widenedLifetimes);
    const widenedAllocA = widenedPlan.decisions.find(
      (d) => d.resourceId === bufA.resourceId
    )?.allocationId;
    const widenedAllocB = widenedPlan.decisions.find(
      (d) => d.resourceId === bufB.resourceId
    )?.allocationId;
    expect(widenedAllocA).not.toBe(widenedAllocB); // Distinct allocations!
  });

  test('allows transient resources after fused group to alias across group boundary', () => {
    const builder = new RenderGraphBuilder();
    const color = builder.createTexture(COLOR_DESC);
    const fusedBufA = builder.createBuffer(BUFFER_DESC);
    const fusedBufB = builder.createBuffer(BUFFER_DESC);
    const afterBuf = builder.createBuffer(BUFFER_DESC);

    let currentColor = color;

    // Pass 0: Fused member A
    builder.addRasterPass({
      id: 'fused-a',
      setup(pass) {
        currentColor = pass.colorAttachment(0, currentColor, {
          load: 'clear',
          store: 'auto'
        });
        pass.writeBuffer(fusedBufA, 'storage-write');
        pass.sideEffect('fused a');
        return {};
      },
      run() {}
    });

    // Pass 1: Fused member B
    builder.addRasterPass({
      id: 'fused-b',
      setup(pass) {
        currentColor = pass.colorAttachment(0, currentColor, {
          load: 'load',
          store: 'store'
        });
        pass.writeBuffer(fusedBufB, 'storage-write');
        pass.sideEffect('fused b');
        return {};
      },
      run() {}
    });

    // Pass 2: Compute pass after fusion group
    builder.addComputePass({
      id: 'post-pass',
      setup(pass) {
        pass.writeBuffer(afterBuf, 'storage-write');
        pass.sideEffect('post');
        return {};
      },
      run() {}
    });

    const snapshot = builder.build();
    const compiled = compileRenderGraph(snapshot);
    const { groups } = partitionRasterGroups(snapshot, compiled);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.retainedPassIndices).toEqual([0, 1]);

    const lifetimes = analyzeResourceLifetimes(snapshot, compiled, groups);
    const plan = planResourceAliases(snapshot, lifetimes);

    const allocFusedA = plan.decisions.find(
      (d) => d.resourceId === fusedBufA.resourceId
    )?.allocationId;
    const allocFusedB = plan.decisions.find(
      (d) => d.resourceId === fusedBufB.resourceId
    )?.allocationId;
    const allocAfter = plan.decisions.find(
      (d) => d.resourceId === afterBuf.resourceId
    )?.allocationId;

    expect(allocFusedA).toBeDefined();
    expect(allocFusedB).toBeDefined();
    expect(allocAfter).toBeDefined();

    // Intra-group transient resources cannot alias together
    expect(allocFusedA).not.toBe(allocFusedB);

    // Post-group transient resource CAN reuse an allocation freed after the group ends
    expect(allocAfter === allocFusedA || allocAfter === allocFusedB).toBe(true);
  });
});
