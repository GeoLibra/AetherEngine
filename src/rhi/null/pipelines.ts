import { NullResourceBase } from '../resource';
import type {
  GPUPrimitiveTopology,
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
    if (descriptor.primitive !== undefined) {
      clone.primitive = { ...descriptor.primitive };
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
    this.descriptor = clone;
  }
}
