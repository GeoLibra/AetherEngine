import { describe, expect, test, vi } from 'vitest';
import {
  BuiltInFeatureImplementation,
  RenderGraphBuilder,
  RenderGraphExecutor,
  ZERO_RESOURCE_BUDGET,
  compileRenderGraph,
  createPreparedComputePipelineToken,
  createPreparedRenderPipelineToken,
  createRenderGraphExecutionPlan,
  createWebGlFragmentLightListImplementation,
  createWebGpuComputeLightListImplementation,
  calculateWebGlLightListPacking,
  type HostServiceId
} from '../../src';
import { NullDevice } from '../../src/rhi/null/device';

const capacity = Object.freeze({
  maxDirectionalLights: 4,
  maxLightsPerReceiver: 8,
  maxLightIndices: 32
});

describe('LightListBuild backend graph implementations', () => {
  test('publishes a stable WebGL2 packing layout at zero and bounded receiver counts', () => {
    expect(calculateWebGlLightListPacking(0, capacity, 4096)).toEqual({
      width: 1,
      height: 3,
      indexRows: 2,
      receiverRows: 1
    });
    expect(calculateWebGlLightListPacking(8, capacity, 6)).toEqual({
      width: 6,
      height: 6,
      indexRows: 2,
      receiverRows: 2
    });
    expect(calculateWebGlLightListPacking(6, capacity, 4096)).toEqual({
      width: 6,
      height: 3,
      indexRows: 2,
      receiverRows: 1
    });
  });

  test('records the selected WebGPU compute implementation into one graph pass', async () => {
    const device = new NullDevice();
    const graph = new RenderGraphBuilder();
    const lights = graph.createBuffer(
      { size: 64, usage: ['storage-read'] },
      {
        origin: {
          kind: 'imported',
          initialState: 'storage-read',
          acquire: { kind: 'external-acquire', id: 'lights' }
        }
      }
    );
    const receivers = graph.createBuffer(
      { size: 64, usage: ['storage-read'] },
      {
        origin: {
          kind: 'imported',
          initialState: 'storage-read',
          acquire: { kind: 'external-acquire', id: 'receivers' }
        }
      }
    );
    const pipelineToken = createPreparedComputePipelineToken('webgpu-light-list');
    const implementation = createWebGpuComputeLightListImplementation({
      capacity,
      estimatedBudget: ZERO_RESOURCE_BUDGET
    });
    const prepared = await implementation.prepare(prepareInput(device));
    const publish = vi.fn();
    implementation.contribute(prepared, {
      graph,
      viewId: 'main',
      input: { lights, receivers, receiverCount: 2 },
      recorder: {
        pipeline: pipelineToken,
        record(context) {
          const pipeline = context.computePipeline(pipelineToken);
          const compute = context.beginCompute({ label: 'webgpu-light-list' });
          compute.setPipeline(pipeline);
          compute.dispatchWorkgroups(2);
          compute.end();
        }
      },
      publish
    });
    const plan = executionPlan(graph);
    const execution = new RenderGraphExecutor().execute(plan, {
      device,
      resources: new Map([
        [lights, device.createBuffer({ size: 64, usage: 1 << 7 })],
        [receivers, device.createBuffer({ size: 64, usage: 1 << 7 })]
      ]),
      preparedComputePipelines: new Map([
        [pipelineToken, device.createComputePipeline({ label: 'webgpu-light-list' })]
      ])
    });
    expect(implementation.id).toBe(BuiltInFeatureImplementation.WebGpuComputeLightList);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ source: 'gpu-compute' }));
    expect(execution.commandStats.computePasses).toBe(1);
    expect(execution.commandStats.compute.dispatchWorkgroups).toBe(1);
  });

  test('records the selected WebGL2 fragment implementation as an integer MRT raster pass', async () => {
    const device = new NullDevice();
    const graph = new RenderGraphBuilder();
    let inputIndex = 0;
    const inputTexture = () =>
      graph.createTexture(
        {
          width: 4,
          height: 1,
          depthOrArrayLayers: 1,
          mipLevelCount: 1,
          sampleCount: 1,
          format: 'rgba32uint',
          usage: ['sampled']
        },
        {
          origin: {
            kind: 'imported',
            initialState: 'sampled',
            acquire: { kind: 'external-acquire', id: `input-${inputIndex++}` }
          }
        }
      );
    const lights = inputTexture();
    const receivers = inputTexture();
    const pipelineToken = createPreparedRenderPipelineToken('webgl-light-list');
    const implementation = createWebGlFragmentLightListImplementation({
      capacity,
      estimatedBudget: ZERO_RESOURCE_BUDGET,
      maxTextureDimension2D: 4096
    });
    const prepared = await implementation.prepare(prepareInput(device));
    let published: unknown;
    implementation.contribute(prepared, {
      graph,
      viewId: 'main',
      input: { lights, receivers, receiverCount: 2 },
      recorder: {
        pipeline: pipelineToken,
        record(context, _input, output) {
          const pipeline = context.renderPipeline(pipelineToken);
          const raster = context.beginRaster({
            label: 'webgl-light-list',
            colorAttachments: [
              output.directionalIndices,
              output.headers,
              output.lightIndices,
              output.overflow
            ].map((texture) => ({ texture, loadOp: 'clear' as const, storeOp: 'store' as const }))
          });
          raster.setPipeline(pipeline);
          raster.draw(3);
          raster.end();
        }
      },
      publish(output) {
        published = output;
      }
    });
    const texture = () =>
      device.createTexture({ size: [4, 1], format: 'rgba32uint', usage: (1 << 2) | (1 << 4) });
    const execution = new RenderGraphExecutor().execute(executionPlan(graph), {
      device,
      resources: new Map([
        [lights, texture()],
        [receivers, texture()]
      ]),
      preparedRenderPipelines: new Map([
        [pipelineToken, device.createRenderPipeline({ label: 'webgl-light-list' })]
      ])
    });
    expect(implementation.id).toBe(BuiltInFeatureImplementation.WebGlFragmentLightList);
    expect(published).toEqual(
      expect.objectContaining({
        source: 'webgl-fragment',
        packing: { width: 2, height: 3, indexRows: 2, receiverRows: 1 }
      })
    );
    expect(execution.commandStats.renderPasses).toBe(1);
    expect(execution.commandStats.draw.drawCalls).toBe(1);
  });
});

function executionPlan(graph: RenderGraphBuilder) {
  const snapshot = graph.build();
  return createRenderGraphExecutionPlan(snapshot, compileRenderGraph(snapshot));
}

function prepareInput(device: NullDevice) {
  return {
    capabilities: device.capabilities,
    hostServices: new Set<HostServiceId>(),
    profileId: 'test',
    deviceGeneration: device.generation,
    budget: ZERO_RESOURCE_BUDGET
  };
}
