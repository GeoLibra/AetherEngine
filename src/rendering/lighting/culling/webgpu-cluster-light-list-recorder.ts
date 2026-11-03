import type { RHIBindGroupLayout, RHIComputePipeline, RHIDevice, RHIResource } from '../../../rhi';
import {
  createPreparedToken,
  type PreparedBindGroupLayoutToken,
  type PreparedComputePipelineToken,
  type BufferHandle,
  type ComputePassContext,
  type RenderGraphBuilder
} from '../../../render-graph';
import { CLUSTER_LIGHT_LIST_SHADER_MODULE } from '../../../shader';
import type { ClusterCapacity, ClusterForwardInputs } from '../types';
import {
  LIGHT_LIST_SHADER_MAX_DIRECTIONAL_LIGHTS,
  LIGHT_LIST_SHADER_MAX_INDICES
} from './light-list-abi';

const COMPUTE_STAGE = 1 << 2;

export interface WebGpuClusterLightListInput {
  readonly lights: BufferHandle;
  readonly clusters: BufferHandle;
}

export interface WebGpuClusterLightListOutput {
  readonly directional: BufferHandle;
  readonly headers: BufferHandle;
  readonly indices: BufferHandle;
  readonly overflow: BufferHandle;
}

/** Creates the physical forward-resource identity after graph output buffers are materialized. */
export function createClusterForwardInputs(input: ClusterForwardInputs): ClusterForwardInputs {
  return Object.freeze({ ...input });
}

/** Prepared WebGPU pipeline for the deterministic clustered-light reference kernel. */
export interface PreparedWebGpuClusterLightListRecorder {
  readonly pipelineToken: PreparedComputePipelineToken;
  readonly bindGroupLayoutToken: PreparedBindGroupLayoutToken;
  readonly pipeline: RHIComputePipeline;
  readonly bindGroupLayout: RHIBindGroupLayout;
  record(
    context: ComputePassContext,
    input: WebGpuClusterLightListInput,
    output: WebGpuClusterLightListOutput
  ): void;
  dispose(): void;
}

export function prepareWebGpuClusterLightListRecorder(
  device: RHIDevice
): PreparedWebGpuClusterLightListRecorder {
  const pipelineToken = createPreparedToken('compute-pipeline', 'aether-cluster-light-list');
  const bindGroupLayoutToken = createPreparedToken(
    'bind-group-layout',
    'aether-cluster-light-list'
  );
  const shader = device.createShaderModule({
    label: 'aether-cluster-light-list',
    code: CLUSTER_LIGHT_LIST_SHADER_MODULE
  });
  const bindGroupLayout = device.createBindGroupLayout({
    label: 'aether-cluster-light-list',
    entries: [0, 1, 2, 3, 4, 5].map((binding) => ({
      binding,
      visibility: COMPUTE_STAGE,
      buffer: { type: binding < 2 ? 'read-only-storage' : 'storage' }
    }))
  });
  const layout = device.createPipelineLayout({
    label: 'aether-cluster-light-list',
    bindGroupLayouts: [bindGroupLayout]
  });
  const pipeline = device.createComputePipeline({
    label: 'aether-cluster-light-list',
    layout,
    compute: { module: shader, entryPoint: 'buildClusterLightList' }
  });
  return Object.freeze({
    pipelineToken,
    bindGroupLayoutToken,
    pipeline,
    bindGroupLayout,
    record(
      context: ComputePassContext,
      input: WebGpuClusterLightListInput,
      output: WebGpuClusterLightListOutput
    ) {
      const group = context.device.createBindGroup({
        label: 'aether-cluster-light-list',
        layout: context.bindGroupLayout(bindGroupLayoutToken),
        entries: [
          { binding: 0, resource: context.buffer(input.lights, 'storage-read') },
          { binding: 1, resource: context.buffer(input.clusters, 'storage-read') },
          { binding: 2, resource: context.buffer(output.directional, 'storage-write') },
          { binding: 3, resource: context.buffer(output.headers, 'storage-write') },
          { binding: 4, resource: context.buffer(output.indices, 'storage-write') },
          { binding: 5, resource: context.buffer(output.overflow, 'storage-write') }
        ]
      });
      context.compute.setPipeline(context.computePipeline(pipelineToken));
      context.compute.setBindGroup(0, group);
      context.compute.dispatchWorkgroups(1);
    },
    dispose() {
      for (const resource of [pipeline, layout, bindGroupLayout, shader].reverse() as RHIResource[])
        resource.dispose();
    }
  });
}

/** Declares the cluster build pass and its storage outputs in the owning RenderGraph. */
export function contributeWebGpuClusterLightList(
  graph: RenderGraphBuilder,
  input: WebGpuClusterLightListInput,
  clusterCount: number,
  capacity: ClusterCapacity,
  recorder: PreparedWebGpuClusterLightListRecorder,
  publish: (output: WebGpuClusterLightListOutput) => void
): void {
  if (!Number.isSafeInteger(clusterCount) || clusterCount < 0) {
    throw new Error('Cluster light-list clusterCount must be a non-negative safe integer.');
  }
  validateCapacity(capacity);
  // The following forward pass reads the bounded output through uniform declarations. Keeping
  // `uniform` in the graph usage makes the storage-write → forward-read transition explicit.
  const directional = graph.createBuffer({
    size: capacity.maxDirectionalLights * 4,
    usage: ['storage-write', 'storage-read', 'uniform', 'copy-src']
  });
  const headers = graph.createBuffer({
    size: Math.max(16, clusterCount * 16),
    usage: ['storage-write', 'storage-read', 'uniform', 'copy-src']
  });
  const indices = graph.createBuffer({
    size: capacity.maxClusterIndices * 4,
    usage: ['storage-write', 'storage-read', 'uniform', 'copy-src']
  });
  const overflow = graph.createBuffer({
    size: 16,
    usage: ['storage-write', 'storage-read', 'uniform', 'copy-src']
  });
  let published: WebGpuClusterLightListOutput | undefined;
  graph.addComputePass({
    id: 'lighting:cluster-light-list:webgpu',
    setup(pass) {
      pass.useComputePipeline(recorder.pipelineToken);
      pass.sideEffect('build clustered-light storage outputs');
      const output = Object.freeze({
        directional: pass.writeBuffer(directional, 'storage-write'),
        headers: pass.writeBuffer(headers, 'storage-write'),
        indices: pass.writeBuffer(indices, 'storage-write'),
        overflow: pass.writeBuffer(overflow, 'storage-write')
      });
      published = output;
      return Object.freeze({
        input: Object.freeze({
          lights: pass.readBuffer(input.lights, 'storage-read'),
          clusters: pass.readBuffer(input.clusters, 'storage-read')
        }),
        output
      });
    },
    run(context, resources) {
      recorder.record(context, resources.input, resources.output);
    }
  });
  if (published === undefined)
    throw new Error('Cluster light-list pass did not publish its outputs.');
  publish(published);
}

function validateCapacity(capacity: ClusterCapacity): void {
  for (const [name, value] of Object.entries(capacity)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`WebGPU cluster light-list ${name} must be a non-negative integer.`);
    }
  }
  if (capacity.maxDirectionalLights > LIGHT_LIST_SHADER_MAX_DIRECTIONAL_LIGHTS) {
    throw new Error('WebGPU cluster directional capacity exceeds the built-in shader maximum.');
  }
  if (capacity.maxClusterIndices > LIGHT_LIST_SHADER_MAX_INDICES) {
    throw new Error('WebGPU cluster index capacity exceeds the built-in shader maximum.');
  }
}
