import { POST_COLOR_SHADER_MODULE } from '../../shader';
import type {
  GPUTextureFormat,
  RHIBindGroupLayout,
  RHIBuffer,
  RHIDevice,
  RHIRenderPipeline,
  RHIResource
} from '../../rhi/contracts';
import {
  createPreparedToken,
  type PreparedBindGroupLayoutToken,
  type PreparedRenderPipelineToken
} from '../../render-graph';

const UNIFORM_BUFFER_USAGE = (1 << 3) | (1 << 6);

/** Prepared full-screen HDR output transform and its immutable bindings. */
export interface BaselinePostColorPreparation {
  readonly pipelineToken: PreparedRenderPipelineToken;
  readonly textureLayoutToken: PreparedBindGroupLayoutToken;
  readonly uniformLayoutToken: PreparedBindGroupLayoutToken;
  readonly pipeline: RHIRenderPipeline;
  readonly textureLayout: RHIBindGroupLayout;
  readonly uniformLayout: RHIBindGroupLayout;
  readonly uniformBuffer: RHIBuffer;
}

/** Creates the baseline HDR exposure and output-transform pipeline. */
export function prepareBaselinePostColor(
  device: RHIDevice,
  surfaceFormat: GPUTextureFormat
): Readonly<{
  preparation: BaselinePostColorPreparation;
  ownedResources: readonly RHIResource[];
}> {
  const shader = device.createShaderModule({
    label: 'aether-post-color',
    code: POST_COLOR_SHADER_MODULE
  });
  const textureLayout = device.createBindGroupLayout({
    label: 'aether-post-color-texture',
    entries: [
      { binding: 0, visibility: 1 << 1, texture: { sampleType: 'float' } },
      { binding: 1, visibility: 1 << 1, sampler: { type: 'filtering' } }
    ]
  });
  const uniformLayout = device.createBindGroupLayout({
    label: 'aether-post-color-uniform',
    entries: [{ binding: 0, visibility: 1 << 1, buffer: { type: 'uniform', minBindingSize: 16 } }]
  });
  const layout = device.createPipelineLayout({
    label: 'aether-post-color',
    bindGroupLayouts: [textureLayout, uniformLayout]
  });
  const pipeline = device.createRenderPipeline({
    label: 'aether-post-color',
    layout,
    vertex: { module: shader, entryPoint: 'postColorVertex' },
    primitive: { topology: 'triangle-list', frontFace: 'ccw', cullMode: 'none' },
    fragment: {
      module: shader,
      entryPoint: 'postColorFragment',
      targets: [{ format: surfaceFormat }]
    }
  });
  const uniformBuffer = device.createBuffer({ size: 16, usage: UNIFORM_BUFFER_USAGE });
  device.queue.writeBuffer(uniformBuffer, 0, new Float32Array([0.005, 0, 0, 0]));
  return Object.freeze({
    preparation: Object.freeze({
      pipelineToken: createPreparedToken('render-pipeline', 'aether-post-color'),
      textureLayoutToken: createPreparedToken('bind-group-layout', 'aether-post-color-texture'),
      uniformLayoutToken: createPreparedToken('bind-group-layout', 'aether-post-color-uniform'),
      pipeline,
      textureLayout,
      uniformLayout,
      uniformBuffer
    }),
    // Creation order makes reverse disposal release dependents before their layouts and shader.
    ownedResources: Object.freeze([
      shader,
      textureLayout,
      uniformLayout,
      layout,
      pipeline,
      uniformBuffer
    ])
  });
}
