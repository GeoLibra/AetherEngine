import { expect, test, vi } from 'vitest';
import {
  RenderGraphBuilder,
  RenderGraphExecutor,
  ZERO_RESOURCE_BUDGET,
  compileRenderGraph,
  createRenderGraphExecutionPlan,
  createWebGpuClusterLightListImplementation,
  prepareWebGpuClusterLightListRecorder
} from '../../src';
import { NullDevice } from '../../src/rhi';

test('contributes the capability-gated cluster build through its own FeaturePolicy seam', async () => {
  const device = new NullDevice();
  const graph = new RenderGraphBuilder();
  const imported = (id: string) =>
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
  const lights = imported('lights');
  const clusters = imported('clusters');
  const recorder = prepareWebGpuClusterLightListRecorder(device);
  const implementation = createWebGpuClusterLightListImplementation({
    capacity: { maxDirectionalLights: 4, maxLightsPerCluster: 8, maxClusterIndices: 16 },
    estimatedBudget: ZERO_RESOURCE_BUDGET
  });
  const prepared = await implementation.prepare({} as never);
  const publish = vi.fn();
  implementation.contribute(prepared, {
    viewId: 'main',
    graph,
    input: { lights, clusters },
    clusterCount: 1,
    recorder,
    publish
  });
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
  expect(implementation.semanticContract).toBe('aether.cluster-light-list-build@1');
  expect(publish).toHaveBeenCalledOnce();
  expect(execution.commandStats.compute.dispatchWorkgroups).toBe(1);
  recorder.dispose();
});
