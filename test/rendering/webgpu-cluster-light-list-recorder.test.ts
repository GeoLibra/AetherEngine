import { expect, test } from 'vitest';
import {
  CLUSTER_LIGHT_LIST_SHADER_ARTIFACT,
  RenderGraphBuilder,
  RenderGraphExecutor,
  compileRenderGraph,
  createClusterForwardInputs,
  createRenderGraphExecutionPlan,
  contributeWebGpuClusterLightList,
  prepareWebGpuClusterLightListRecorder,
  type WebGpuClusterLightListOutput
} from '../../src';
import { NullDevice } from '../../src/rhi';

test('prepares the dedicated deterministic WebGPU clustered-light compute pipeline', () => {
  expect(CLUSTER_LIGHT_LIST_SHADER_ARTIFACT.entryPoints).toContainEqual(
    expect.objectContaining({ name: 'buildClusterLightList', stage: 'compute' })
  );
  const recorder = prepareWebGpuClusterLightListRecorder(new NullDevice());
  expect(recorder.pipeline.descriptor.compute?.entryPoint).toBe('buildClusterLightList');
  expect(CLUSTER_LIGHT_LIST_SHADER_ARTIFACT.bindings).toHaveLength(6);
  recorder.dispose();
});

test('publishes one frozen typed resource group for a cluster forward consumer', () => {
  const device = new NullDevice();
  const buffer = () => device.createBuffer({ size: 16, usage: 1 << 7 });
  const inputs = createClusterForwardInputs({
    metadata: buffer(),
    packedLights: buffer(),
    directional: buffer(),
    headers: buffer(),
    indices: buffer(),
    overflow: buffer()
  });
  expect(Object.isFrozen(inputs)).toBe(true);
  expect(inputs.headers).toBe(inputs.headers);
});

test('declares one compute pass and observable cluster output buffers', () => {
  const graph = new RenderGraphBuilder();
  const input = (id: string) =>
    graph.createBuffer(
      { size: 64, usage: ['storage-read'] },
      {
        origin: {
          kind: 'imported',
          initialState: 'storage-read',
          acquire: { kind: 'external-acquire', id }
        }
      }
    );
  const recorder = prepareWebGpuClusterLightListRecorder(new NullDevice());
  let output: WebGpuClusterLightListOutput | undefined;
  contributeWebGpuClusterLightList(
    graph,
    { lights: input('lights'), clusters: input('clusters') },
    2,
    { maxDirectionalLights: 4, maxLightsPerCluster: 8, maxClusterIndices: 16 },
    recorder,
    (value) => {
      output = value;
    }
  );
  const snapshot = graph.build();
  expect(snapshot.passes).toHaveLength(1);
  expect(output).toEqual(
    expect.objectContaining({
      directional: expect.anything(),
      headers: expect.anything(),
      indices: expect.anything(),
      overflow: expect.anything()
    })
  );
  expect(captureOutput(output!)).toEqual([1, 1, 1, 1]);
  recorder.dispose();
});

function captureOutput(output: {
  readonly directional: { readonly version: number };
  readonly headers: { readonly version: number };
  readonly indices: { readonly version: number };
  readonly overflow: { readonly version: number };
}): readonly number[] {
  return Object.freeze([
    output.directional.version,
    output.headers.version,
    output.indices.version,
    output.overflow.version
  ]);
}

test('executes the declared cluster reference pass once', () => {
  const device = new NullDevice();
  const graph = new RenderGraphBuilder();
  const input = (id: string) =>
    graph.createBuffer(
      { size: 64, usage: ['storage-read'] },
      {
        origin: {
          kind: 'imported',
          initialState: 'storage-read',
          acquire: { kind: 'external-acquire', id }
        }
      }
    );
  const lights = input('lights');
  const clusters = input('clusters');
  const recorder = prepareWebGpuClusterLightListRecorder(device);
  contributeWebGpuClusterLightList(
    graph,
    { lights, clusters },
    1,
    { maxDirectionalLights: 4, maxLightsPerCluster: 8, maxClusterIndices: 16 },
    recorder,
    () => undefined
  );
  const snapshot = graph.build();
  const execution = new RenderGraphExecutor().execute(
    createRenderGraphExecutionPlan(snapshot, compileRenderGraph(snapshot)),
    {
      device,
      resources: new Map([
        [lights, device.createBuffer({ size: 64, usage: 1 << 7 })],
        [clusters, device.createBuffer({ size: 64, usage: 1 << 7 })]
      ]),
      preparedComputePipelines: new Map([[recorder.pipelineToken, recorder.pipeline]]),
      preparedBindGroupLayouts: new Map([[recorder.bindGroupLayoutToken, recorder.bindGroupLayout]])
    }
  );
  expect(execution.commandStats.compute.dispatchWorkgroups).toBe(1);
  recorder.dispose();
});
