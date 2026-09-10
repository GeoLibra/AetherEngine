import type { RHIBindGroupLayout, RHIComputePipeline, RHIDevice, RHIResource } from '../../../rhi';
import {
  createPreparedBindGroupLayoutToken,
  createPreparedComputePipelineToken,
  type PreparedBindGroupLayoutToken,
  type PreparedComputePipelineToken
} from '../../../render-graph';
import type { ComputePassContext } from '../../../render-graph';
import { LIGHT_LIST_SHADER_MODULE } from '../../../shader';
import type {
  WebGpuLightListBuildInput,
  WebGpuLightListBuildOutput,
  WebGpuLightListBuildRecorder
} from '../types';

const COMPUTE_STAGE = 1 << 2;

export interface PreparedWebGpuLightListRecorder {
  readonly recorder: WebGpuLightListBuildRecorder;
  readonly pipelineToken: PreparedComputePipelineToken;
  readonly bindGroupLayoutToken: PreparedBindGroupLayoutToken;
  readonly pipeline: RHIComputePipeline;
  readonly bindGroupLayout: RHIBindGroupLayout;
  dispose(): void;
}

/**
 * Creates the built-in deterministic WebGPU light-list pipeline before surface acquisition.
 * The returned bindings must be supplied to RenderGraphExecutor for every graph using the recorder.
 */
export function prepareWebGpuLightListRecorder(device: RHIDevice): PreparedWebGpuLightListRecorder {
  const pipelineToken = createPreparedComputePipelineToken('aether-light-list');
  const bindGroupLayoutToken = createPreparedBindGroupLayoutToken('aether-light-list');
  const shader = device.createShaderModule({
    label: 'aether-light-list',
    code: LIGHT_LIST_SHADER_MODULE
  });
  const bindGroupLayout = device.createBindGroupLayout({
    label: 'aether-light-list',
    entries: [
      storageEntry(0, 'read-only-storage'),
      storageEntry(1, 'read-only-storage'),
      storageEntry(2, 'storage'),
      storageEntry(3, 'storage'),
      storageEntry(4, 'storage'),
      storageEntry(5, 'storage')
    ]
  });
  const pipelineLayout = device.createPipelineLayout({
    label: 'aether-light-list',
    bindGroupLayouts: [bindGroupLayout]
  });
  const pipeline = device.createComputePipeline({
    label: 'aether-light-list',
    layout: pipelineLayout,
    compute: { module: shader, entryPoint: 'buildLightList' }
  });
  const recorder: WebGpuLightListBuildRecorder = Object.freeze({
    pipeline: pipelineToken,
    record(
      context: ComputePassContext,
      input: WebGpuLightListBuildInput,
      output: WebGpuLightListBuildOutput
    ) {
      const layout = context.bindGroupLayout(bindGroupLayoutToken);
      const group = context.device.createBindGroup({
        label: 'aether-light-list',
        layout,
        entries: [
          { binding: 0, resource: context.buffer(input.lights, 'storage-read') },
          { binding: 1, resource: context.buffer(input.receivers, 'storage-read') },
          { binding: 2, resource: context.buffer(output.directionalIndices, 'storage-write') },
          { binding: 3, resource: context.buffer(output.headers, 'storage-write') },
          { binding: 4, resource: context.buffer(output.lightIndices, 'storage-write') },
          { binding: 5, resource: context.buffer(output.overflow, 'storage-write') }
        ]
      });
      const pipeline = context.computePipeline(pipelineToken);
      context.compute.setPipeline(pipeline);
      context.compute.setBindGroup(0, group);
      context.compute.dispatchWorkgroups(1);
    }
  });
  return Object.freeze({
    recorder,
    pipelineToken,
    bindGroupLayoutToken,
    pipeline,
    bindGroupLayout,
    dispose() {
      disposeAll([pipeline, pipelineLayout, bindGroupLayout, shader]);
    }
  });
}

function storageEntry(binding: number, type: 'storage' | 'read-only-storage') {
  return Object.freeze({ binding, visibility: COMPUTE_STAGE, buffer: { type } });
}

function disposeAll(resources: readonly RHIResource[]): void {
  for (const resource of resources) resource.dispose();
}
