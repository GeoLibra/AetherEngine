import { NullResourceBase } from '../resource';
import type {
  GPUBlendComponent,
  GPUBlendState,
  GPUColorTargetState,
  GPUDepthStencilState,
  GPUFragmentState,
  GPUMultisampleState,
  GPUPrimitiveTopology,
  GPUPrimitiveState,
  GPUProgrammableStage,
  GPUVertexAttribute,
  GPUVertexBufferLayout,
  GPUVertexState,
  RHIComputePipeline,
  RHIComputePipelineDescriptor,
  RHIPipelineLayout,
  RHIRenderPipeline,
  RHIRenderPipelineDescriptor
} from '../types';

export class NullRenderPipeline extends NullResourceBase implements RHIRenderPipeline {
  readonly kind = 'render-pipeline';
  readonly descriptor: Readonly<RHIRenderPipelineDescriptor>;
  readonly layout: RHIPipelineLayout | undefined;

  constructor(id: number, owner: symbol, descriptor: RHIRenderPipelineDescriptor) {
    super(id, owner, descriptor.label);
    const clone: RHIRenderPipelineDescriptor = {};
    if (descriptor.label !== undefined) {
      clone.label = descriptor.label;
    }
    if (descriptor.vertex !== undefined) {
      clone.vertex = cloneVertexState(descriptor.vertex);
    }
    if (descriptor.primitive !== undefined) {
      clone.primitive = clonePrimitiveState(descriptor.primitive);
    }
    if (descriptor.depthStencil !== undefined) {
      clone.depthStencil = cloneDepthStencilState(descriptor.depthStencil);
    }
    if (descriptor.multisample !== undefined) {
      clone.multisample = { ...descriptor.multisample };
    }
    if (descriptor.fragment !== undefined) {
      clone.fragment = cloneFragmentState(descriptor.fragment);
    }
    if (descriptor.layout !== undefined) {
      clone.layout = descriptor.layout;
      this.layout = descriptor.layout;
    }
    this.descriptor = clone;
  }

  get topology(): GPUPrimitiveTopology | undefined {
    return this.descriptor.primitive?.topology;
  }
}

export class NullComputePipeline extends NullResourceBase implements RHIComputePipeline {
  readonly kind = 'compute-pipeline';
  readonly descriptor: Readonly<RHIComputePipelineDescriptor>;
  readonly layout: RHIPipelineLayout | undefined;

  constructor(id: number, owner: symbol, descriptor: RHIComputePipelineDescriptor) {
    super(id, owner, descriptor.label);
    const clone: RHIComputePipelineDescriptor = {};
    if (descriptor.label !== undefined) {
      clone.label = descriptor.label;
    }
    if (descriptor.layout !== undefined) {
      clone.layout = descriptor.layout;
      this.layout = descriptor.layout;
    }
    if (descriptor.compute !== undefined) {
      clone.compute = cloneProgrammableStage(descriptor.compute);
    }
    this.descriptor = clone;
  }
}

function cloneProgrammableStage<TStage extends GPUProgrammableStage>(stage: TStage): TStage {
  const clone = {
    module: stage.module
  } as TStage;
  if (stage.entryPoint !== undefined) {
    clone.entryPoint = stage.entryPoint;
  }
  if (stage.constants !== undefined) {
    clone.constants = { ...stage.constants };
  }
  return clone;
}

function cloneVertexState(state: GPUVertexState): GPUVertexState {
  const clone = cloneProgrammableStage(state);
  if (state.buffers !== undefined) {
    clone.buffers = state.buffers.map((buffer) => (buffer === null ? null : cloneVertexBufferLayout(buffer)));
  }
  return clone;
}

function cloneVertexBufferLayout(layout: GPUVertexBufferLayout): GPUVertexBufferLayout {
  const clone: GPUVertexBufferLayout = {
    arrayStride: layout.arrayStride,
    attributes: layout.attributes.map(cloneVertexAttribute)
  };
  if (layout.stepMode !== undefined) {
    clone.stepMode = layout.stepMode;
  }
  return clone;
}

function cloneVertexAttribute(attribute: GPUVertexAttribute): GPUVertexAttribute {
  return { ...attribute };
}

function cloneFragmentState(state: GPUFragmentState): GPUFragmentState {
  const clone = cloneProgrammableStage(state);
  clone.targets = state.targets.map((target) => (target === null ? null : cloneColorTargetState(target)));
  return clone;
}

function cloneColorTargetState(target: GPUColorTargetState): GPUColorTargetState {
  const clone: GPUColorTargetState = {
    format: target.format
  };
  if (target.blend !== undefined) {
    clone.blend = cloneBlendState(target.blend);
  }
  if (target.writeMask !== undefined) {
    clone.writeMask = target.writeMask;
  }
  return clone;
}

function cloneBlendState(blend: GPUBlendState): GPUBlendState {
  return {
    color: cloneBlendComponent(blend.color),
    alpha: cloneBlendComponent(blend.alpha)
  };
}

function cloneBlendComponent(component: GPUBlendComponent): GPUBlendComponent {
  return { ...component };
}

function clonePrimitiveState(state: GPUPrimitiveState): GPUPrimitiveState {
  return { ...state };
}

function cloneDepthStencilState(state: GPUDepthStencilState): GPUDepthStencilState {
  return { ...state };
}
