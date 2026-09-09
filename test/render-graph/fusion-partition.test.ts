import { describe, expect, test } from 'vitest';
import { RenderGraphBuilder } from '../../src/render-graph/builder';
import { compileRenderGraph } from '../../src/render-graph/compiler';
import { partitionRasterGroups } from '../../src/render-graph/compiler/fusion/partition';
import { SplitReasonCode } from '../../src/render-graph/compiler/fusion/constants';
import type { TextureDescriptor } from '../../src/render-graph/types';

function createColorDesc(): TextureDescriptor {
  return {
    width: 64,
    height: 64,
    depthOrArrayLayers: 1,
    mipLevelCount: 1,
    sampleCount: 1,
    format: 'rgba8unorm',
    usage: ['color-attachment', 'sampled']
  };
}

function createDepthDesc(): TextureDescriptor {
  return {
    width: 64,
    height: 64,
    depthOrArrayLayers: 1,
    mipLevelCount: 1,
    sampleCount: 1,
    format: 'depth24plus',
    usage: ['depth-stencil-attachment', 'sampled']
  };
}

describe('RenderGraph Pass Fusion Partitioning', () => {
  test('fuses two adjacent compatible raster passes into a single physical group', () => {
    const builder = new RenderGraphBuilder();
    const color = builder.createTexture(createColorDesc());

    let currentColor = color;
    builder.addRasterPass({
      id: 'pass-a',
      setup(pass) {
        currentColor = pass.colorAttachment(0, currentColor, {
          load: 'clear',
          clearValue: [0, 0, 0, 1],
          store: 'auto'
        });
        pass.sideEffect('a');
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
        pass.sideEffect('b');
        return {};
      },
      run() {}
    });

    const snapshot = builder.build();
    const compiled = compileRenderGraph(snapshot);
    const result = partitionRasterGroups(snapshot, compiled);

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.retainedPassIndices).toEqual([0, 1]);
    expect(result.counters.fusedBoundariesCount).toBe(1);
    expect(result.counters.physicalRasterGroups).toBe(1);
    expect(result.splitRecords).toHaveLength(0);
    expect(result.groups[0]?.attachments.colorAttachments[0]?.loadOp).toBe('clear');
    expect(result.groups[0]?.attachments.colorAttachments[0]?.storeOp).toBe('store');
  });

  test('records optimization-disabled when enablePassFusion is false', () => {
    const builder = new RenderGraphBuilder();
    const color = builder.createTexture(createColorDesc());

    let currentColor = color;
    builder.addRasterPass({
      id: 'pass-a',
      setup(pass) {
        currentColor = pass.colorAttachment(0, currentColor, {
          load: 'clear',
          store: 'auto'
        });
        pass.sideEffect('a');
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
        pass.sideEffect('b');
        return {};
      },
      run() {}
    });

    const snapshot = builder.build();
    const compiled = compileRenderGraph(snapshot);
    const result = partitionRasterGroups(snapshot, compiled, { enablePassFusion: false });

    expect(result.groups).toHaveLength(2);
    expect(result.counters.fusedBoundariesCount).toBe(0);
    expect(result.splitRecords).toHaveLength(1);
    expect(result.splitRecords[0]?.reason).toBe(SplitReasonCode.OptimizationDisabled);
  });

  test('splits on intermediate compute pass boundary', () => {
    const builder = new RenderGraphBuilder();
    const color = builder.createTexture(createColorDesc());

    let currentColor = color;
    builder.addRasterPass({
      id: 'pass-a',
      setup(pass) {
        currentColor = pass.colorAttachment(0, currentColor, {
          load: 'clear',
          store: 'auto'
        });
        pass.sideEffect('a');
        return {};
      },
      run() {}
    });

    builder.addComputePass({
      id: 'pass-compute',
      setup(pass) {
        pass.sideEffect('compute');
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
        pass.sideEffect('b');
        return {};
      },
      run() {}
    });

    const snapshot = builder.build();
    const compiled = compileRenderGraph(snapshot);
    const result = partitionRasterGroups(snapshot, compiled);

    expect(result.groups).toHaveLength(2);
    expect(result.counters.fusedBoundariesCount).toBe(0);
    expect(result.splitRecords[0]?.reason).toBe(SplitReasonCode.NonRasterBoundary);
  });

  test('splits on intermediate clear operation', () => {
    const builder = new RenderGraphBuilder();
    const color = builder.createTexture(createColorDesc());

    let currentColor = color;
    builder.addRasterPass({
      id: 'pass-a',
      setup(pass) {
        currentColor = pass.colorAttachment(0, currentColor, {
          load: 'clear',
          store: 'auto'
        });
        pass.sideEffect('a');
        return {};
      },
      run() {}
    });

    builder.addRasterPass({
      id: 'pass-b',
      setup(pass) {
        // Intervening clear is illegal within a single physical pass
        currentColor = pass.colorAttachment(0, currentColor, {
          load: 'clear',
          store: 'store'
        });
        pass.sideEffect('b');
        return {};
      },
      run() {}
    });

    const snapshot = builder.build();
    const compiled = compileRenderGraph(snapshot);
    const result = partitionRasterGroups(snapshot, compiled);

    expect(result.groups).toHaveLength(2);
    expect(result.splitRecords[0]?.reason).toBe(SplitReasonCode.IntermediateClear);
  });

  test('proves safe late depth introduction and lifts depth clear to group begin', () => {
    const builder = new RenderGraphBuilder();
    const color = builder.createTexture(createColorDesc());
    const depth = builder.createTexture(createDepthDesc());

    let currentColor = color;
    // Pass A: Skybox / background without depth attachment
    builder.addRasterPass({
      id: 'pass-background',
      setup(pass) {
        currentColor = pass.colorAttachment(0, currentColor, {
          load: 'clear',
          clearValue: [0.1, 0.2, 0.3, 1],
          store: 'auto'
        });
        pass.sideEffect('bg');
        return {};
      },
      run() {}
    });

    // Pass B: Opaque pass introducing depth with clear
    builder.addRasterPass({
      id: 'pass-opaque',
      setup(pass) {
        currentColor = pass.colorAttachment(0, currentColor, {
          load: 'load',
          store: 'store'
        });
        pass.depthStencilAttachment(depth, {
          depthLoad: 'clear',
          depthClearValue: 1.0,
          depthStore: 'discard'
        });
        pass.sideEffect('opaque');
        return {};
      },
      run() {}
    });

    const snapshot = builder.build();
    const compiled = compileRenderGraph(snapshot);
    const result = partitionRasterGroups(snapshot, compiled);

    expect(result.groups).toHaveLength(1);
    expect(result.counters.fusedBoundariesCount).toBe(1);
    expect(result.groups[0]?.retainedPassIndices).toEqual([0, 1]);
    expect(result.groups[0]?.attachments.depthStencilAttachment?.depthLoadOp).toBe('clear');
    expect(result.groups[0]?.attachments.depthStencilAttachment?.depthClearValue).toBe(1.0);
    expect(result.groups[0]?.attachments.depthStencilAttachment?.depthStoreOp).toBe('discard');
  });

  test('rejects late depth introduction if previous member accessed depth texture', () => {
    const builder = new RenderGraphBuilder();
    const color = builder.createTexture(createColorDesc());
    const depth = builder.createTexture(createDepthDesc(), {
      origin: {
        kind: 'imported',
        acquire: { kind: 'external-acquire', id: 'ext-depth' },
        initialState: 'sampled'
      }
    });

    let currentColor = color;
    // Pass A touches depth as a sampled texture
    builder.addRasterPass({
      id: 'pass-background',
      setup(pass) {
        currentColor = pass.colorAttachment(0, currentColor, {
          load: 'clear',
          store: 'auto'
        });
        pass.readTexture(depth, 'sampled');
        pass.sideEffect('bg');
        return {};
      },
      run() {}
    });

    builder.addRasterPass({
      id: 'pass-opaque',
      setup(pass) {
        currentColor = pass.colorAttachment(0, currentColor, {
          load: 'load',
          store: 'store'
        });
        pass.depthStencilAttachment(depth, {
          depthLoad: 'clear',
          depthClearValue: 1.0,
          depthStore: 'discard'
        });
        pass.sideEffect('opaque');
        return {};
      },
      run() {}
    });

    const snapshot = builder.build();
    const compiled = compileRenderGraph(snapshot);
    const result = partitionRasterGroups(snapshot, compiled);

    expect(result.groups).toHaveLength(2);
    expect(result.splitRecords[0]?.reason).toBe(SplitReasonCode.DepthIntroductionUnproven);
  });

  test('rejects late depth introduction if candidate does not clear depth', () => {
    const builder = new RenderGraphBuilder();
    const color = builder.createTexture(createColorDesc());
    const depth = builder.createTexture(createDepthDesc());

    let currentColor = color;
    builder.addRasterPass({
      id: 'pass-background',
      setup(pass) {
        currentColor = pass.colorAttachment(0, currentColor, {
          load: 'clear',
          store: 'auto'
        });
        pass.sideEffect('bg');
        return {};
      },
      run() {}
    });

    builder.addRasterPass({
      id: 'pass-opaque',
      setup(pass) {
        currentColor = pass.colorAttachment(0, currentColor, {
          load: 'load',
          store: 'store'
        });
        // Non-clearing depth introduction is unproven
        pass.depthStencilAttachment(depth, {
          depthLoad: 'load',
          depthStore: 'store'
        });
        pass.sideEffect('opaque');
        return {};
      },
      run() {}
    });

    const snapshot = builder.build();
    const compiled = compileRenderGraph(snapshot);
    const result = partitionRasterGroups(snapshot, compiled);

    expect(result.groups).toHaveLength(2);
    expect(result.splitRecords[0]?.reason).toBe(SplitReasonCode.DepthIntroductionUnproven);
  });

  test('splits on maxGroupPassCount limit', () => {
    const builder = new RenderGraphBuilder();
    const color = builder.createTexture(createColorDesc());

    let currentColor = color;
    for (let i = 0; i < 3; i++) {
      const id = `pass-${i}`;
      builder.addRasterPass({
        id,
        setup(pass) {
          currentColor = pass.colorAttachment(0, currentColor, {
            load: i === 0 ? 'clear' : 'load',
            store: 'auto'
          });
          pass.sideEffect(id);
          return {};
        },
        run() {}
      });
    }

    const snapshot = builder.build();
    const compiled = compileRenderGraph(snapshot);
    const result = partitionRasterGroups(snapshot, compiled, { maxGroupPassCount: 2 });

    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]?.retainedPassIndices).toEqual([0, 1]);
    expect(result.groups[1]?.retainedPassIndices).toEqual([2]);
    expect(result.splitRecords[0]?.reason).toBe(SplitReasonCode.GroupPassLimit);
  });
});
