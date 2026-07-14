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
  GPUSupportedLimits,
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
} from '../types';
import { createNullConformanceCapabilities } from '../capabilities';
import type { DeviceCapabilities } from '../capability-types';
import type { DeviceLostInfo, RHIDeviceState } from '../lifecycle-types';
import { assertRHIFeature } from '../capability-validation';
import type {
  RHIBindGroupDescriptor,
  RHIBindGroupLayoutDescriptor,
  RHIBufferDescriptor,
  RHICommandEncoderDescriptor,
  RHIPipelineLayoutDescriptor,
  RHISamplerDescriptor,
  RHIShaderModuleDescriptor,
  RHITextureDescriptor
} from '../descriptor-types';

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
    this.capabilities = options.capabilities ?? createNullConformanceCapabilities();
    this.owner = {
      token: Symbol('NullDevice'),
      generation: this.generation,
      capabilities: this.capabilities,
      state: 'live'
    };
    this.queue = new NullQueue(this.owner);
    this.lost = new Promise((resolve) => { this.resolveLost = resolve; });
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

  createBuffer(descriptor: RHIBufferDescriptor): RHIBuffer {
    return new NullBuffer(this.allocateId(), this.owner, descriptor);
  }

  createTexture(descriptor: RHITextureDescriptor): RHITexture {
    return new NullTexture(this.allocateId(), this.owner, descriptor, () => this.allocateId());
  }

  createSampler(descriptor: RHISamplerDescriptor = {}): RHISampler {
    return new NullSampler(this.allocateId(), this.owner, descriptor);
  }

  createShaderModule(descriptor: RHIShaderModuleDescriptor): RHIShaderModule {
    return new NullShaderModule(this.allocateId(), this.owner, descriptor);
  }

  createBindGroupLayout(descriptor: RHIBindGroupLayoutDescriptor): RHIBindGroupLayout {
    for (const entry of descriptor.entries) {
      if (entry.buffer?.type === 'storage' || entry.buffer?.type === 'read-only-storage') {
        assertRHIFeature(this.owner, 'storage-buffer', 'create-storage-buffer');
      }
      if (entry.storageTexture !== undefined) {
        assertRHIFeature(this.owner, 'storage-texture', 'create-storage-texture');
      }
    }
    return new NullBindGroupLayout(this.allocateId(), this.owner, descriptor);
  }

  createPipelineLayout(descriptor: RHIPipelineLayoutDescriptor): RHIPipelineLayout {
    return new NullPipelineLayout(this.allocateId(), this.owner, descriptor);
  }

  createBindGroup(descriptor: RHIBindGroupDescriptor): RHIBindGroup {
    return new NullBindGroup(this.allocateId(), this.owner, descriptor);
  }

  createRenderPipeline(descriptor: RHIRenderPipelineDescriptor): RHIRenderPipeline {
    validatePipelineDescriptorObject(descriptor, 'Render');
    validatePipelineLayout(descriptor.layout, this.owner);
    validateRenderPipelineDescriptor(descriptor, this.owner);
    return new NullRenderPipeline(this.allocateId(), this.owner, descriptor);
  }

  createComputePipeline(descriptor: RHIComputePipelineDescriptor = {}): RHIComputePipeline {
    assertRHIFeature(this.owner, 'compute', 'create-compute-pipeline');
    validatePipelineDescriptorObject(descriptor, 'Compute');
    validatePipelineLayout(descriptor.layout, this.owner);
    validateComputePipelineDescriptor(descriptor, this.owner);
    return new NullComputePipeline(this.allocateId(), this.owner, descriptor);
  }

  createRenderTarget(descriptor: RenderTargetDescriptor): RHIRenderTarget {
    return new NullRenderTarget(this.allocateId(), this.owner, descriptor);
  }

  createCommandEncoder(descriptor: RHICommandEncoderDescriptor = {}): RHICommandEncoder {
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
