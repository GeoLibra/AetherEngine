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
    const bufA = builder.createBuffer(
      { ...BUFFER_DESC, usage: ['uniform'] },
      {
        origin: {
          kind: 'imported',
          initialState: 'uniform',
          acquire: { kind: 'external-acquire', id: 'bufA' }
        }
      }
    );
    const bufB = builder.createBuffer(
      { ...BUFFER_DESC, usage: ['uniform'] },
      {
        origin: {
          kind: 'imported',
          initialState: 'uniform',
          acquire: { kind: 'external-acquire', id: 'bufB' }
        }
      }
    );

    let currentColor = color;

    // Pass 0: member A reads bufA
    builder.addRasterPass({
      id: 'pass-a',
      setup(pass) {
        currentColor = pass.colorAttachment(0, currentColor, {
          load: 'clear',
          store: 'auto'
        });
        pass.readBuffer(bufA, 'uniform');
        pass.sideEffect('member a');
        return {};
      },
      run() {}
    });

    // Pass 1: member B reads bufB
    builder.addRasterPass({
      id: 'pass-b',
      setup(pass) {
        currentColor = pass.colorAttachment(0, currentColor, {
          load: 'load',
          store: 'store'
        });
        pass.readBuffer(bufB, 'uniform');
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
    const DEPTH_DESC: TextureDescriptor = Object.freeze({
      width: 64,
      height: 64,
      depthOrArrayLayers: 1,
      mipLevelCount: 1,
      sampleCount: 1,
      format: 'depth32float',
      usage: Object.freeze([
        'depth-stencil-attachment',
        'sampled',
        'copy-dst',
        'storage-write'
      ] as const)
    });

    const builder = new RenderGraphBuilder();
    const color = builder.createTexture(COLOR_DESC);
    const depthA = builder.createTexture(DEPTH_DESC);
    const depthB = builder.createTexture(DEPTH_DESC);

    let currentColor = color;
    let writtenDepthA = depthA;

    // Pass 0: initializes depthA via copy pass
    builder.addCopyPass({
      id: 'prep-a',
      setup(pass) {
        writtenDepthA = pass.writeTexture(depthA, 'copy-dst');
        pass.sideEffect('prep a');
        return {};
      },
      run() {}
    });

    // Pass 1: member A uses depthA as sampled texture
    builder.addRasterPass({
      id: 'pass-a',
      setup(pass) {
        currentColor = pass.colorAttachment(0, currentColor, {
          load: 'clear',
          store: 'auto'
        });
        pass.readTexture(writtenDepthA, 'sampled');
        pass.sideEffect('member a');
        return {};
      },
      run() {}
    });

    // Pass 2: member B safe late depth introduction with depthB
    builder.addRasterPass({
      id: 'pass-b',
      setup(pass) {
        currentColor = pass.colorAttachment(0, currentColor, {
          load: 'load',
          store: 'store'
        });
        pass.depthStencilAttachment(depthB, {
          depthLoad: 'clear',
          depthStore: 'discard'
        });
        pass.sideEffect('member b');
        return {};
      },
      run() {}
    });

    const snapshot = builder.build();
    const compiled = compileRenderGraph(snapshot);
    const { groups } = partitionRasterGroups(snapshot, compiled);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.retainedPassIndices).toEqual([1, 2]);

    // Without fusion awareness: disjoint lifetimes allow depthA and depthB to share allocationId 0
    const unwidenedLifetimes = analyzeResourceLifetimes(snapshot, compiled);
    const unwidenedPlan = planResourceAliases(snapshot, unwidenedLifetimes);
    const unwidenedAllocA = unwidenedPlan.decisions.find(
      (d) => d.resourceId === depthA.resourceId
    )?.allocationId;
    const unwidenedAllocB = unwidenedPlan.decisions.find(
      (d) => d.resourceId === depthB.resourceId
    )?.allocationId;
    expect(unwidenedAllocA).toBe(unwidenedAllocB); // Same allocation!

    // With fusion awareness: widened lifetimes overlap, requiring separate allocations
    const widenedLifetimes = analyzeResourceLifetimes(snapshot, compiled, groups);
    const widenedPlan = planResourceAliases(snapshot, widenedLifetimes);
    const widenedAllocA = widenedPlan.decisions.find(
      (d) => d.resourceId === depthA.resourceId
    )?.allocationId;
    const widenedAllocB = widenedPlan.decisions.find(
      (d) => d.resourceId === depthB.resourceId
    )?.allocationId;
    expect(widenedAllocA).not.toBe(widenedAllocB); // Distinct allocations!
  });

  test('allows transient resources after fused group to alias across group boundary', () => {
    const DEPTH_DESC: TextureDescriptor = Object.freeze({
      width: 64,
      height: 64,
      depthOrArrayLayers: 1,
      mipLevelCount: 1,
      sampleCount: 1,
      format: 'depth32float',
      usage: Object.freeze([
        'depth-stencil-attachment',
        'sampled',
        'copy-dst',
        'storage-write'
      ] as const)
    });

    const builder = new RenderGraphBuilder();
    const color = builder.createTexture(COLOR_DESC);
    const fusedDepthA = builder.createTexture(DEPTH_DESC);
    const fusedDepthB = builder.createTexture(DEPTH_DESC);
    const afterDepth = builder.createTexture(DEPTH_DESC);

    let currentColor = color;
    let writtenFusedDepthA = fusedDepthA;

    // Pass 0: initializes fusedDepthA via copy pass
    builder.addCopyPass({
      id: 'prep-a',
      setup(pass) {
        writtenFusedDepthA = pass.writeTexture(fusedDepthA, 'copy-dst');
        pass.sideEffect('prep a');
        return {};
      },
      run() {}
    });

    // Pass 1: Fused member A
    builder.addRasterPass({
      id: 'fused-a',
      setup(pass) {
        currentColor = pass.colorAttachment(0, currentColor, {
          load: 'clear',
          store: 'auto'
        });
        pass.readTexture(writtenFusedDepthA, 'sampled');
        pass.sideEffect('fused a');
        return {};
      },
      run() {}
    });

    // Pass 2: Fused member B
    builder.addRasterPass({
      id: 'fused-b',
      setup(pass) {
        currentColor = pass.colorAttachment(0, currentColor, {
          load: 'load',
          store: 'store'
        });
        pass.depthStencilAttachment(fusedDepthB, {
          depthLoad: 'clear',
          depthStore: 'discard'
        });
        pass.sideEffect('fused b');
        return {};
      },
      run() {}
    });

    // Pass 3: Compute pass after fusion group
    builder.addComputePass({
      id: 'post-pass',
      setup(pass) {
        pass.writeTexture(afterDepth, 'storage-write');
        pass.sideEffect('post');
        return {};
      },
      run() {}
    });

    const snapshot = builder.build();
    const compiled = compileRenderGraph(snapshot);
    const { groups } = partitionRasterGroups(snapshot, compiled);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.retainedPassIndices).toEqual([1, 2]);

    const lifetimes = analyzeResourceLifetimes(snapshot, compiled, groups);
    const plan = planResourceAliases(snapshot, lifetimes);

    const allocFusedA = plan.decisions.find(
      (d) => d.resourceId === fusedDepthA.resourceId
    )?.allocationId;
    const allocFusedB = plan.decisions.find(
      (d) => d.resourceId === fusedDepthB.resourceId
    )?.allocationId;
    const allocAfter = plan.decisions.find(
      (d) => d.resourceId === afterDepth.resourceId
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
