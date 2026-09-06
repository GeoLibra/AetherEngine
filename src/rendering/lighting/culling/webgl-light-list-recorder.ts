import type { RHIBindGroupLayout, RHIDevice, RHIRenderPipeline, RHIResource } from '../../../rhi';
import {
  createPreparedBindGroupLayoutToken,
  createPreparedRenderPipelineToken,
  type PreparedBindGroupLayoutToken,
  type PreparedRenderPipelineToken,
  type RestrictedPassContext
} from '../../../render-graph';
import { LIGHT_LIST_WEBGL2_SHADER_MODULE } from '../../../shader';
import type {
  WebGlFragmentLightListBuildInput,
  WebGlFragmentLightListBuildOutput,
  WebGlFragmentLightListBuildRecorder
} from '../types';

const FRAGMENT_STAGE = 1 << 1;

export interface PreparedWebGlLightListRecorder {
  readonly recorder: WebGlFragmentLightListBuildRecorder;
  readonly pipelineToken: PreparedRenderPipelineToken;
  readonly bindGroupLayoutToken: PreparedBindGroupLayoutToken;
  readonly pipeline: RHIRenderPipeline;
  readonly bindGroupLayout: RHIBindGroupLayout;
  dispose(): void;
}

/** Creates the cooked fullscreen integer-MRT pipeline before graph execution. */
export function prepareWebGlLightListRecorder(device: RHIDevice): PreparedWebGlLightListRecorder {
  const pipelineToken = createPreparedRenderPipelineToken('aether-light-list-webgl');
  const bindGroupLayoutToken = createPreparedBindGroupLayoutToken('aether-light-list-webgl');
  const shader = device.createShaderModule({
    label: 'aether-light-list-webgl',
    code: LIGHT_LIST_WEBGL2_SHADER_MODULE
  });
  const bindGroupLayout = device.createBindGroupLayout({
    label: 'aether-light-list-webgl',
    entries: [textureEntry(0), textureEntry(1)]
  });
  const pipelineLayout = device.createPipelineLayout({
    label: 'aether-light-list-webgl',
    bindGroupLayouts: [bindGroupLayout]
  });
  const pipeline = device.createRenderPipeline({
    label: 'aether-light-list-webgl',
    layout: pipelineLayout,
    vertex: { module: shader, entryPoint: 'lightListVertex' },
    fragment: {
      module: shader,
      entryPoint: 'lightListFragment',
      targets: Array.from({ length: 4 }, () => ({ format: 'rgba32uint' as const }))
    }
  });
  const recorder: WebGlFragmentLightListBuildRecorder = Object.freeze({
    pipeline: pipelineToken,
    record(
      context: RestrictedPassContext,
      input: WebGlFragmentLightListBuildInput,
      output: WebGlFragmentLightListBuildOutput
    ) {
      const layout = context.bindGroupLayout(bindGroupLayoutToken);
      const group = context.device.createBindGroup({
        label: 'aether-light-list-webgl',
        layout,
        entries: [
          { binding: 0, resource: context.texture(input.lights, 'sampled') },
          { binding: 1, resource: context.texture(input.receivers, 'sampled') }
        ]
      });
      const pipeline = context.renderPipeline(pipelineToken);
      const pass = context.beginRaster({
        label: 'aether-light-list-webgl',
        colorAttachments: [
          attachment(output.directionalIndices),
          attachment(output.headers),
          attachment(output.lightIndices),
          attachment(output.overflow)
        ]
      });
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, group);
      pass.draw(3);
      pass.end();
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

function textureEntry(binding: number) {
  return Object.freeze({
    binding,
    visibility: FRAGMENT_STAGE,
    texture: { sampleType: 'uint' as const }
  });
}

function attachment(texture: WebGlFragmentLightListBuildOutput['directionalIndices']) {
  return Object.freeze({
    texture,
    loadOp: 'clear' as const,
    storeOp: 'store' as const,
    clearValue: { r: 0, g: 0, b: 0, a: 0 }
  });
}

function disposeAll(resources: readonly RHIResource[]): void {
  for (const resource of resources) resource.dispose();
}
