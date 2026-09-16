import { describe, expect, test } from 'vitest';
import { RenderGraphBuilder } from '../../src/render-graph/builder';
import {
  RenderGraphExecutor,
  createRenderGraphExecutionPlan
} from '../../src/render-graph/executor';
import { compileRenderGraph } from '../../src/render-graph/compiler';
import { HistoryRegistry, type HistoryIdentity } from '../../src/render-graph/history';
import type {
  BufferDescriptor,
  ComputePassContext,
  CopyPassContext,
  GraphHandle,
  RenderGraphExecutionPlan,
  TextureDescriptor
} from '../../src/render-graph/types';
import type { RHIBuffer, RHITexture } from '../../src/rhi/contracts';
import { NullDevice } from '../../src/rhi/null/device';

const MULTI_RANGE_BUFFER: BufferDescriptor = {
  size: 64,
  usage: ['uniform']
};
const DEPTH_TEXTURE: TextureDescriptor = {
  width: 4,
  height: 4,
  depthOrArrayLayers: 1,
  mipLevelCount: 2,
  sampleCount: 1,
  format: 'depth24plus-stencil8',
  usage: ['sampled']
};

function compile(builder: RenderGraphBuilder): RenderGraphExecutionPlan {
  const snapshot = builder.build();
  return createRenderGraphExecutionPlan(snapshot, compileRenderGraph(snapshot));
}

describe('RenderGraph final-review regressions', () => {
  test('resolves a requested buffer range against every same-handle usage declaration', () => {
    const device = new NullDevice();
    const graph = new RenderGraphBuilder();
    const logical = graph.createBuffer(MULTI_RANGE_BUFFER, {
      origin: {
        kind: 'imported',
        initialState: 'uniform',
        acquire: { kind: 'external-acquire', id: 'multi-range-buffer' }
      }
    });
    graph.addCopyPass({
      id: 'read-disjoint-buffer-ranges',
      setup(pass) {
        pass.readBuffer(logical, 'uniform', { offset: 0, size: 16 });
        pass.readBuffer(logical, 'uniform', { offset: 32, size: 16 });
        pass.sideEffect('resolve the second declaration');
        return { logical };
      },
      run(context: CopyPassContext, resources) {
        expect(
          context.buffer(resources.logical, 'uniform', { offset: 32, size: 16 })
        ).toMatchObject({ offset: 32, size: 16 });
      }
    });

    new RenderGraphExecutor().execute(compile(graph), {
      device,
      resources: new Map([[logical, device.createBuffer({ size: 64, usage: 64 })]])
    });
  });

  test('normalizes depth-stencil requests with the real descriptor before matching declarations', () => {
    const device = new NullDevice();
    const graph = new RenderGraphBuilder();
    const logical = graph.createTexture(DEPTH_TEXTURE, {
      origin: {
        kind: 'imported',
        initialState: 'sampled',
        acquire: { kind: 'external-acquire', id: 'multi-range-depth' }
      }
    });
    graph.addCopyPass({
      id: 'read-disjoint-depth-ranges',
      setup(pass) {
        pass.readTexture(logical, 'sampled', {
          baseMipLevel: 0,
          mipLevelCount: 1,
          baseArrayLayer: 0,
          arrayLayerCount: 1,
          aspect: 'all'
        });
        pass.readTexture(logical, 'sampled', {
          baseMipLevel: 1,
          mipLevelCount: 1,
          baseArrayLayer: 0,
          arrayLayerCount: 1,
          aspect: 'all'
        });
        pass.sideEffect('resolve the second depth declaration');
        return { logical };
      },
      run(context: CopyPassContext, resources) {
        expect(
          context.texture(resources.logical, 'sampled', {
            baseMipLevel: 1,
            mipLevelCount: 1,
            baseArrayLayer: 0,
            arrayLayerCount: 1,
            aspect: 'depth-only'
          }).range
        ).toMatchObject({ baseMipLevel: 1, aspect: 'depth-only' });
      }
    });

    new RenderGraphExecutor().execute(compile(graph), {
      device,
      resources: new Map<GraphHandle, RHIBuffer | RHITexture>([
        [
          logical,
          device.createTexture({
            size: { width: 4, height: 4, depthOrArrayLayers: 1 },
            mipLevelCount: 2,
            format: 'depth24plus-stencil8',
            usage: 4
          })
        ]
      ])
    });
  });

  test('uses declared buffer slices for compute bindings and copy commands', () => {
    const device = new NullDevice();
    const graph = new RenderGraphBuilder();
    const source = graph.createBuffer(
      { size: 64, usage: ['storage-read', 'copy-src'] },
      {
        origin: {
          kind: 'imported',
          initialState: 'storage-read',
          acquire: { kind: 'external-acquire', id: 'compute-source' }
        }
      }
    );
    const sampled = graph.createTexture(
      {
        width: 4,
        height: 4,
        depthOrArrayLayers: 1,
        mipLevelCount: 1,
        sampleCount: 1,
        format: 'rgba8unorm',
        usage: ['sampled']
      },
      {
        origin: {
          kind: 'imported',
          initialState: 'sampled',
          acquire: { kind: 'external-acquire', id: 'compute-sampled' }
        }
      }
    );
    const destination = graph.createBuffer({ size: 64, usage: ['copy-dst'] });
    graph.addComputePass({
      id: 'compute-slices',
      setup(pass) {
        const input = pass.readBuffer(source, 'storage-read', { offset: 16, size: 16 });
        const sampledView = pass.readTexture(sampled, 'sampled');
        pass.sideEffect('bind declared slices');
        return { input, sampledView };
      },
      run(context: ComputePassContext, resources) {
        const input = context.buffer(resources.input, 'storage-read', { offset: 16, size: 16 });
        const sampledView = context.texture(resources.sampledView, 'sampled');
        const layout = context.device.createBindGroupLayout({
          entries: [
            { binding: 0, visibility: 4, buffer: { type: 'read-only-storage' } },
            { binding: 1, visibility: 4, texture: { sampleType: 'float' } }
          ]
        });
        const bindGroup = context.device.createBindGroup({
          layout,
          entries: [
            { binding: 0, resource: input },
            { binding: 1, resource: sampledView }
          ]
        });
        const pipeline = context.device.createComputePipeline({
          layout: context.device.createPipelineLayout({ bindGroupLayouts: [layout] })
        });
        context.compute.setPipeline(pipeline);
        context.compute.setBindGroup(0, bindGroup);
        context.compute.dispatchWorkgroups(1);
      }
    });
    graph.addCopyPass({
      id: 'copy-slices',
      setup(pass) {
        const copySource = pass.readBuffer(source, 'copy-src', { offset: 16, size: 16 });
        const output = pass.writeBuffer(destination, 'copy-dst', { offset: 32, size: 16 });
        pass.sideEffect('copy declared slices');
        return { copySource, output };
      },
      run(context: CopyPassContext, resources) {
        const copySource = context.buffer(resources.copySource, 'copy-src', {
          offset: 16,
          size: 16
        });
        const output = context.buffer(resources.output, 'copy-dst', { offset: 32, size: 16 });
        context.copy.copyBufferToBuffer(copySource, output);
      }
    });

    const execution = new RenderGraphExecutor().execute(compile(graph), {
      device,
      resources: new Map<GraphHandle, RHIBuffer | RHITexture>([
        [source, device.createBuffer({ size: 64, usage: 132 })],
        [
          sampled,
          device.createTexture({
            size: { width: 4, height: 4, depthOrArrayLayers: 1 },
            format: 'rgba8unorm',
            usage: 4
          })
        ]
      ])
    });

    expect(execution.commandStats.compute.dispatchWorkgroups).toBe(1);
    expect(execution.commandStats.copy.copyBufferToBuffer).toBe(1);
    expect(execution.commandBuffer.getCommandStream()).toContainEqual(
      expect.objectContaining({
        kind: 'copyBufferToBuffer',
        sourceOffset: 16,
        destinationOffset: 32,
        size: 16
      })
    );
  });

  test('binds history v0 to the latest published slot and v1 to a distinct writable slot', () => {
    const device = new NullDevice({ submissionMode: 'manual' });
    const registry = new HistoryRegistry(device);
    const historyIdentity: HistoryIdentity = {
      deviceGeneration: device.generation,
      viewId: 'main',
      key: 'temporal/color',
      slots: 3,
      descriptor: {
        kind: 'buffer',
        descriptor: { size: 64, usage: 12 }
      }
    };

    const first = registry.acquire(historyIdentity);
    expect(first.readable).toBeUndefined();
    expect(first.writable.slot).toBe(0);
    const firstGraph = new RenderGraphBuilder();
    const firstHistory = firstGraph.createBuffer(
      { size: 64, usage: ['copy-src', 'copy-dst'] },
      {
        origin: { kind: 'history', key: historyIdentity.key, slots: historyIdentity.slots },
        historyValid: false
      }
    );
    firstGraph.addCopyPass({
      id: 'first-history-output',
      setup(pass) {
        const output = pass.writeBuffer(firstHistory, 'copy-dst');
        pass.sideEffect('publish first history output');
        return { output };
      },
      run() {}
    });
    new RenderGraphExecutor().execute(compile(firstGraph), {
      device,
      histories: new Map([[firstHistory, { ...first, registry, identity: historyIdentity }]])
    });

    const second = registry.acquire(historyIdentity);
    expect(second.readable).toMatchObject({ slot: 0, valid: true });
    expect(second.writable.slot).toBe(1);
    expect(second.writable.handle).not.toBe(second.readable?.handle);
    const secondGraph = new RenderGraphBuilder();
    const secondHistory = secondGraph.createBuffer(
      { size: 64, usage: ['copy-src', 'copy-dst'] },
      {
        origin: { kind: 'history', key: historyIdentity.key, slots: historyIdentity.slots },
        historyValid: true
      }
    );
    secondGraph.addCopyPass({
      id: 'temporal-history-copy',
      setup(pass) {
        const previous = pass.readBuffer(secondHistory, 'copy-src');
        const output = pass.writeBuffer(secondHistory, 'copy-dst');
        pass.sideEffect('publish next history output');
        return { previous, output };
      },
      run(context: CopyPassContext, resources) {
        context.copy.copyBufferToBuffer(
          context.buffer(resources.previous, 'copy-src'),
          context.buffer(resources.output, 'copy-dst')
        );
      }
    });
    const execution = new RenderGraphExecutor().execute(
      compile(secondGraph),
      {
        device,
        histories: new Map([[secondHistory, { ...second, registry, identity: historyIdentity }]])
      },
      { captureDebug: true }
    );

    expect(execution.commandBuffer.getCommandStream()).toContainEqual(
      expect.objectContaining({
        kind: 'copyBufferToBuffer',
        source: expect.objectContaining({ id: second.readable?.handle.id }),
        destination: expect.objectContaining({ id: second.writable.handle.id })
      })
    );
    expect(execution.debug?.resources[secondHistory.resourceId]?.history).toMatchObject({
      readableSlot: 0,
      writableSlot: 1,
      versionSlots: [
        { version: 0, slot: 0 },
        { version: 1, slot: 1 }
      ]
    });
    const third = registry.acquire(historyIdentity);
    expect(third.readable).toMatchObject({ slot: 1, valid: true });
    expect(third.writable.slot).toBe(2);
  });
});
