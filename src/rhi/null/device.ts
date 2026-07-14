import { NullBindGroup, NullBindGroupLayout, NullPipelineLayout, NullShaderModule, validatePipelineLayout } from './bindings';
import { NullBuffer } from './buffer';
import { NullCommandEncoder } from './command';
import { NullComputePipeline, NullRenderPipeline } from './pipelines';
import { validateComputePipelineDescriptor, validateRenderPipelineDescriptor } from './pipeline-validation';
import { NullQueue } from './queue';
import { NullSampler, NullTexture } from './texture';
import { NullRenderTarget } from '../render-target';
import type { NullDeviceOwner } from '../resource';
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
  RHISampler,
  RHIShaderModule,
  RHITexture,
  RenderTargetDescriptor,
  GPUShaderModuleDescriptor
} from '../types';
import { createNullCapabilities } from '../capabilities';
import type { DeviceCapabilities } from '../capability-types';
import type { DeviceLostInfo, RHIDeviceState } from '../lifecycle-types';

let nextDeviceGeneration = 1;

export interface NullDeviceOptions {
  readonly capabilities?: DeviceCapabilities;
}

export class NullDevice implements RHIDevice {
  private readonly owner: NullDeviceOwner;

  readonly queue: NullQueue;
  readonly capabilities: DeviceCapabilities;
  readonly generation = nextDeviceGeneration++;
  readonly lost: Promise<DeviceLostInfo>;
  readonly features: ReadonlySet<string>;
  readonly limits: GPUSupportedLimits;

  private nextResourceId = 1;
  private currentState: RHIDeviceState = 'live';
  private resolveLost!: (info: DeviceLostInfo) => void;

  constructor(options: NullDeviceOptions = {}) {
    this.owner = {
      token: Symbol('NullDevice'),
      generation: this.generation,
      state: 'live'
    };
    this.queue = new NullQueue(this.owner);
    this.lost = new Promise((resolve) => { this.resolveLost = resolve; });
    this.capabilities = options.capabilities ?? createNullCapabilities();
    this.features = new Set(
      [...this.capabilities.features]
        .filter(([, support]) => support.status !== 'unsupported')
        .map(([feature]) => feature)
    );
    this.limits = this.capabilities.limits;
  }

  get state(): RHIDeviceState { return this.currentState; }

  loseForTesting(reason: DeviceLostInfo['reason'], message: string): void {
    if (this.currentState !== 'live') return;
    this.currentState = 'lost';
    this.owner.state = 'lost';
    this.resolveLost(Object.freeze({ reason, message, generation: this.generation }));
  }

  destroy(): void {
    if (this.currentState === 'destroyed') return;
    if (this.currentState === 'live') {
      this.currentState = 'destroyed';
      this.owner.state = 'destroyed';
      this.resolveLost(Object.freeze({
        reason: 'destroyed',
        message: 'NullDevice was destroyed.',
        generation: this.generation
      }));
      return;
    }
    this.currentState = 'destroyed';
    this.owner.state = 'destroyed';
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

  private allocateId(): number {
    if (this.currentState !== 'live') throw new Error('NullDevice is lost.');
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
