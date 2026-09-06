import { describe, expect, test, vi } from 'vitest';
import {
  BuiltInFeatureImplementation,
  LIGHT_LIST_SHADER_ARTIFACT,
  RenderGraphBuilder,
  RenderGraphExecutor,
  ZERO_RESOURCE_BUDGET,
  compileRenderGraph,
  createRenderGraphExecutionPlan,
  createWebGlFragmentLightListImplementation,
  createWebGpuComputeLightListImplementation,
  calculateWebGlLightListPacking,
  decodeWebGpuLightListOutput,
  packWebGpuLightListInput,
  prepareWebGlLightListRecorder,
  prepareWebGpuLightListRecorder,
  type HostServiceId,
  type RenderEntityId
} from '../../src';
import { NullDevice } from '../../src/rhi/null/device';

const capacity = Object.freeze({
  maxDirectionalLights: 4,
  maxLightsPerReceiver: 8,
  maxLightIndices: 32
});

describe('LightListBuild backend graph implementations', () => {
  test('keeps the cooked WebGPU kernel binding ABI aligned with the recorder', () => {
    const entryPoint = LIGHT_LIST_SHADER_ARTIFACT.entryPoints.find(
      (entry) => entry.name === 'buildLightList'
    );
    expect(entryPoint?.stage).toBe('compute');
    expect(
      entryPoint?.bindings.map(({ binding, kind, access }) => ({ binding, kind, access }))
    ).toEqual([
      { binding: 0, kind: 'storage-buffer', access: 'read' },
      { binding: 1, kind: 'storage-buffer', access: 'read' },
      { binding: 2, kind: 'storage-buffer', access: 'read-write' },
      { binding: 3, kind: 'storage-buffer', access: 'read-write' },
      { binding: 4, kind: 'storage-buffer', access: 'read-write' },
      { binding: 5, kind: 'storage-buffer', access: 'read-write' }
    ]);
  });

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
    const preparedRecorder = prepareWebGpuLightListRecorder(device);
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
      recorder: preparedRecorder.recorder,
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
        [preparedRecorder.pipelineToken, preparedRecorder.pipeline]
      ]),
      preparedBindGroupLayouts: new Map([
        [preparedRecorder.bindGroupLayoutToken, preparedRecorder.bindGroupLayout]
      ])
    });
    expect(implementation.id).toBe(BuiltInFeatureImplementation.WebGpuComputeLightList);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ source: 'gpu-compute' }));
    expect(execution.commandStats.computePasses).toBe(1);
    expect(execution.commandStats.compute.dispatchWorkgroups).toBe(1);
    preparedRecorder.dispose();
  });

  test('packs ordered CPU inputs into the built-in WebGPU ABI', () => {
    const packed = packWebGpuLightListInput({
      viewLayerMask: 3,
      capacity,
      lights: [
        {
          entity: 9 as RenderEntityId,
          payloadVersion: 1,
          kind: 'point',
          position: [1, 2, 3],
          luminousIntensityCandela: 4,
          range: 5,
          colorLinear: [1, 1, 1],
          enabled: true,
          layerMask: 1,
          castsShadow: false
        },
        {
          entity: 2 as RenderEntityId,
          payloadVersion: 1,
          kind: 'directional',
          direction: [0, -1, 0],
          illuminanceLux: 10,
          colorLinear: [1, 1, 1],
          enabled: true,
          layerMask: 3,
          castsShadow: false
        }
      ],
      receivers: [
        {
          renderEntity: 7 as RenderEntityId,
          layerMask: 1,
          bounds: { kind: 'sphere', center: [0, 0, 0], radius: 2 }
        }
      ]
    });

    expect(packed.orderedLights.map((light) => light.entity)).toEqual([2, 9]);
    expect([...packed.lights.slice(0, 4)]).toEqual([2, 3, 0, 0]);
    expect([...packed.receivers.slice(0, 4)]).toEqual([1, 8, 4, 32]);
    expect(packed.receivers[4]).toBe(7);
  });

  test('decodes bounded WebGPU readback counts and overflow flags', () => {
    expect(
      decodeWebGpuLightListOutput({
        directionalIndices: new Uint32Array([2, 9, 99]),
        headers: new Uint32Array([7, 0, 2, 1, 8, 2, 1, 0]),
        lightIndices: new Uint32Array([3, 4, 5, 99]),
        overflow: new Uint32Array([0x4000_0002, 2, 3, 0])
      })
    ).toEqual({
      directionalIndices: [2, 9],
      headers: [
        { receiver: 7, offset: 0, count: 2, overflowed: true },
        { receiver: 8, offset: 2, count: 1, overflowed: false }
      ],
      lightIndices: [3, 4, 5],
      overflowed: true
    });
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
    const preparedRecorder = prepareWebGlLightListRecorder(device);
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
      recorder: preparedRecorder.recorder,
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
        [preparedRecorder.pipelineToken, preparedRecorder.pipeline]
      ]),
      preparedBindGroupLayouts: new Map([
        [preparedRecorder.bindGroupLayoutToken, preparedRecorder.bindGroupLayout]
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
    preparedRecorder.dispose();
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
