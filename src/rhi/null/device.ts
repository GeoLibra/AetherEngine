import { NullBindGroup, NullBindGroupLayout, NullPipelineLayout, NullShaderModule, validatePipelineLayout } from './bindings';
import { NullBuffer } from './buffer';
import { NullCommandEncoder } from './command';
import { NullComputePipeline, NullRenderPipeline } from './pipelines';
import { validateComputePipelineDescriptor, validateRenderPipelineDescriptor } from './pipeline-validation';
import { NullQueue } from './queue';
import { NullSampler, NullTexture } from './texture';
import { NullRenderTarget } from '../render-target';
import { assertResourceOwnedBy, NullResourceBase } from '../resource';
import type {
  GPUBindGroupDescriptor,
  GPUBindGroupLayoutDescriptor,
  GPUBufferDescriptor,
  GPUCommandEncoderDescriptor,
  GPUPipelineLayoutDescriptor,
  GPUSamplerDescriptor,
  GPUSupportedLimits,
  GPUTextureDescriptor,
  RHIBindGroup,
  RHIBindGroupLayout,
  RHIBuffer,
  RHICommandEncoder,
  RHIComputePipelineDescriptor,
  RHIComputePipeline,
  RHIDevice,
  RHIPipelineLayout,
  RHIRenderPipeline,
  RHIRenderPipelineDescriptor,
  RHIRenderTarget,
  RHIResource,
  RHISampler,
  RHIShaderModule,
  RHITexture,
  RenderTargetDescriptor,
  GPUShaderModuleDescriptor
} from '../types';
import { createNullCapabilities } from '../capabilities';
import type { DeviceCapabilities } from '../capability-types';

export interface NullDeviceOptions {
  readonly capabilities?: DeviceCapabilities;
}

export class NullDevice implements RHIDevice {
  private readonly owner = Symbol('NullDevice');

  readonly queue = new NullQueue(this.owner);
  readonly capabilities: DeviceCapabilities;
  readonly features: ReadonlySet<string>;
  readonly limits: GPUSupportedLimits;

  private nextResourceId = 1;

  constructor(options: NullDeviceOptions = {}) {
    this.capabilities = options.capabilities ?? createNullCapabilities();
    this.features = new Set(
      [...this.capabilities.features]
        .filter(([, support]) => support.status !== 'unsupported')
        .map(([feature]) => feature)
    );
    this.limits = this.capabilities.limits;
  }

  createBuffer(descriptor: GPUBufferDescriptor): RHIBuffer {
    return new NullBuffer(this.allocateId(), this.owner, descriptor);
  }

  createTexture(descriptor: GPUTextureDescriptor): RHITexture {
    return new NullTexture(this.allocateId(), this.owner, descriptor, () => this.allocateId());
  }

  createSampler(descriptor: GPUSamplerDescriptor = {}): RHISampler {
    return new NullSampler(this.allocateId(), this.owner, descriptor);
  }

  createShaderModule(descriptor: GPUShaderModuleDescriptor): RHIShaderModule {
    return new NullShaderModule(this.allocateId(), this.owner, descriptor);
  }

  createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): RHIBindGroupLayout {
    return new NullBindGroupLayout(this.allocateId(), this.owner, descriptor);
  }

  createPipelineLayout(descriptor: GPUPipelineLayoutDescriptor): RHIPipelineLayout {
    return new NullPipelineLayout(this.allocateId(), this.owner, descriptor);
  }

  createBindGroup(descriptor: GPUBindGroupDescriptor): RHIBindGroup {
    return new NullBindGroup(this.allocateId(), this.owner, descriptor);
  }

  createRenderPipeline(descriptor: RHIRenderPipelineDescriptor): RHIRenderPipeline {
    validatePipelineDescriptorObject(descriptor, 'Render');
    validatePipelineLayout(descriptor.layout, this.owner);
    validateRenderPipelineDescriptor(descriptor, this.owner);
    return new NullRenderPipeline(this.allocateId(), this.owner, descriptor);
  }

  createComputePipeline(descriptor: RHIComputePipelineDescriptor = {}): RHIComputePipeline {
    validatePipelineDescriptorObject(descriptor, 'Compute');
    validatePipelineLayout(descriptor.layout, this.owner);
    validateComputePipelineDescriptor(descriptor, this.owner);
    return new NullComputePipeline(this.allocateId(), this.owner, descriptor);
  }

  createRenderTarget(descriptor: RenderTargetDescriptor): RHIRenderTarget {
    return new NullRenderTarget(this.allocateId(), this.owner, descriptor);
  }

  createCommandEncoder(descriptor: GPUCommandEncoderDescriptor = {}): RHICommandEncoder {
    return new NullCommandEncoder(this.allocateId(), this.owner, descriptor);
  }

  destroy(resource: RHIResource): void {
    // ADR-001: Public resources are released through the owning device.
    if (!(resource instanceof NullResourceBase)) {
      const label =
        typeof resource === 'object' && resource !== null && 'label' in resource
          ? String(resource.label)
          : 'unknown';
      throw new Error(`Resource "${label}" was not created by NullDevice.`);
    }
    assertResourceOwnedBy(resource, this.owner);
    resource.release();
  }

  private allocateId(): number {
    const id = this.nextResourceId;
    this.nextResourceId += 1;
    return id;
  }
}

function validatePipelineDescriptorObject(
  descriptor: RHIRenderPipelineDescriptor | RHIComputePipelineDescriptor,
  name: 'Render' | 'Compute'
): void {
  if (typeof descriptor !== 'object' || descriptor === null || Array.isArray(descriptor)) {
    throw new Error(`${name} pipeline descriptor must be an object.`);
  }
}
