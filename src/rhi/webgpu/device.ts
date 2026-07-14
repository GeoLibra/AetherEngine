import type { DeviceCapabilities } from '../capability-types';
import type { RHICommandBuffer, RHICommandEncoder } from '../command-types';
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
import type { RHIDevice, RHIQueue } from '../device-types';
import type { DeviceLostInfo, RHIDeviceState } from '../lifecycle-types';
import type {
  GPUImageCopyTexture,
  RHIBindGroup,
  RHIBindGroupLayout,
  RHIBuffer,
  RHIComputePipeline,
  RHIComputePipelineDescriptor,
  RHIPipelineLayout,
  RHIRenderPipeline,
  RHIRenderPipelineDescriptor,
  RHISampler,
  RHIShaderModule,
  RHITexture
} from '../resource-types';
import type { RHIQueueMetrics, RHISubmission } from '../submission-types';
import type { BufferWriteRange, GPUExtent3D, GPUImageDataLayout, RHIUploadData } from '../webgpu-types';
import type { WebGPUNativeDeviceLostInfo, WebGPUNativeDevicePort } from './native-types';
import type { WebGPUNativeResourcePort, WebGPUNativeTexturePort } from './native-types';
import {
  WebGPUBindGroup,
  WebGPUBindGroupLayout,
  WebGPUBuffer,
  WebGPUComputePipeline,
  WebGPUPipelineLayout,
  WebGPURenderPipeline,
  WebGPUSampler,
  WebGPUShaderModule,
  WebGPUTexture,
  getWebGPUNativeHandle,
  lowerBindingResource,
  normalizeExtent,
  type WebGPUDeviceOwner
} from './resource';

let nextWebGPUGeneration = 1;

export class WebGPUDevice implements RHIDevice {
  readonly generation = nextWebGPUGeneration++;
  readonly queue: RHIQueue = new PendingWebGPUQueue();
  readonly lost: Promise<DeviceLostInfo>;

  private currentState: RHIDeviceState = 'live';
  private resolveLost!: (info: DeviceLostInfo) => void;
  private nextResourceId = 1;
  private readonly owner: WebGPUDeviceOwner;

  constructor(
    readonly capabilities: DeviceCapabilities,
    private readonly native: WebGPUNativeDevicePort
  ) {
    this.owner = {
      token: Symbol('WebGPUDevice'),
      generation: this.generation,
      state: 'live',
      allocateId: () => this.allocateId()
    };
    this.lost = new Promise((resolve) => { this.resolveLost = resolve; });
    void native.lost.then((info) => this.handleNativeLoss(info));
  }

  get state(): RHIDeviceState {
    return this.currentState;
  }

  createBuffer(descriptor: RHIBufferDescriptor): RHIBuffer {
    const snapshot = freezeRecord({ ...descriptor });
    return new WebGPUBuffer(this.allocateId(), this.owner, this.createNative('createBuffer', snapshot), descriptor);
  }
  createTexture(descriptor: RHITextureDescriptor): RHITexture {
    const snapshot = freezeRecord({ ...descriptor, size: normalizeExtent(descriptor.size) });
    const native = this.native.createTexture;
    if (native === undefined) return pending('createTexture');
    return new WebGPUTexture(this.allocateId(), this.owner, native.call(this.native, snapshot), descriptor);
  }
  createSampler(descriptor: RHISamplerDescriptor = {}): RHISampler {
    const snapshot = freezeRecord({ ...descriptor });
    return new WebGPUSampler(this.allocateId(), this.owner, this.createNative('createSampler', snapshot), descriptor);
  }
  createShaderModule(descriptor: RHIShaderModuleDescriptor): RHIShaderModule {
    const snapshot = freezeRecord({ ...descriptor });
    return new WebGPUShaderModule(this.allocateId(), this.owner, this.createNative('createShaderModule', snapshot), descriptor);
  }
  createBindGroupLayout(descriptor: RHIBindGroupLayoutDescriptor): RHIBindGroupLayout {
    const entries = Object.freeze(descriptor.entries.map((entry) => Object.freeze({ ...entry })));
    const snapshot = freezeRecord({ ...(descriptor.label === undefined ? {} : { label: descriptor.label }), entries });
    return new WebGPUBindGroupLayout(this.allocateId(), this.owner, this.createNative('createBindGroupLayout', snapshot), descriptor);
  }
  createPipelineLayout(descriptor: RHIPipelineLayoutDescriptor): RHIPipelineLayout {
    const bindGroupLayouts = Object.freeze(descriptor.bindGroupLayouts.map(
      (layout) => getWebGPUNativeHandle(layout, this.owner)
    ));
    const snapshot = freezeRecord({ ...(descriptor.label === undefined ? {} : { label: descriptor.label }), bindGroupLayouts });
    return new WebGPUPipelineLayout(this.allocateId(), this.owner, this.createNative('createPipelineLayout', snapshot), descriptor);
  }
  createBindGroup(descriptor: RHIBindGroupDescriptor): RHIBindGroup {
    const layout = getWebGPUNativeHandle(descriptor.layout, this.owner);
    const entries = Object.freeze(descriptor.entries.map((entry) => Object.freeze({
      binding: entry.binding,
      resource: lowerBindingResource(entry.resource, this.owner)
    })));
    const snapshot = freezeRecord({ ...(descriptor.label === undefined ? {} : { label: descriptor.label }), layout, entries });
    return new WebGPUBindGroup(this.allocateId(), this.owner, this.createNative('createBindGroup', snapshot), descriptor);
  }
  createRenderPipeline(descriptor: RHIRenderPipelineDescriptor): RHIRenderPipeline {
    const snapshot = lowerRenderPipeline(descriptor, this.owner);
    return new WebGPURenderPipeline(this.allocateId(), this.owner, this.createNative('createRenderPipeline', snapshot), descriptor);
  }
  createComputePipeline(descriptor: RHIComputePipelineDescriptor = {}): RHIComputePipeline {
    const snapshot = lowerComputePipeline(descriptor, this.owner);
    return new WebGPUComputePipeline(this.allocateId(), this.owner, this.createNative('createComputePipeline', snapshot), descriptor);
  }
  createCommandEncoder(_descriptor: RHICommandEncoderDescriptor = {}): RHICommandEncoder { return pending('createCommandEncoder'); }

  destroy(): void {
    if (this.currentState === 'destroyed') return;
    this.currentState = 'destroyed';
    this.owner.state = 'destroyed';
    this.native.destroy?.();
    this.resolveLost(Object.freeze({
      reason: 'destroyed',
      message: 'WebGPUDevice was destroyed.',
      generation: this.generation
    }));
  }

  private handleNativeLoss(info: WebGPUNativeDeviceLostInfo): void {
    if (this.currentState !== 'live') return;
    this.currentState = 'lost';
    this.owner.state = 'lost';
    this.resolveLost(Object.freeze({
      reason: normalizeLossReason(info.reason),
      message: info.message ?? 'WebGPU device was lost.',
      generation: this.generation
    }));
  }

  private allocateId(): number {
    if (this.currentState !== 'live') throw new Error('WebGPUDevice is lost.');
    return this.nextResourceId++;
  }

  private createNative(
    operation: Exclude<keyof WebGPUNativeDevicePort, 'lost' | 'destroy' | 'createTexture'>,
    descriptor: Readonly<Record<string, unknown>>
  ): WebGPUNativeResourcePort {
    const method = this.native[operation];
    if (method === undefined) return pending(operation);
    return method.call(this.native, descriptor);
  }
}

class PendingWebGPUQueue implements RHIQueue {
  submit(_commandBuffers: readonly RHICommandBuffer[]): RHISubmission { return pending('queue.submit'); }
  metrics(): RHIQueueMetrics {
    return Object.freeze({ submitted: 0, pending: 0, completed: 0, failed: 0, deviceLost: 0, leasedResources: 0 });
  }
  writeBuffer(_buffer: RHIBuffer, _offset: number, _data: RHIUploadData): void { pending('queue.writeBuffer'); }
  writeBufferRanges(_buffer: RHIBuffer, _ranges: readonly BufferWriteRange[]): void { pending('queue.writeBufferRanges'); }
  writeTexture(
    _destination: GPUImageCopyTexture,
    _data: RHIUploadData,
    _dataLayout: GPUImageDataLayout,
    _size: GPUExtent3D
  ): void { pending('queue.writeTexture'); }
}

function pending<T>(operation: string): T {
  throw new Error(`WebGPU backend operation ${operation} is not implemented yet.`);
}

function normalizeLossReason(reason: string | undefined): DeviceLostInfo['reason'] {
  if (reason === 'destroyed' || reason === 'out-of-memory' || reason === 'context-lost') return reason;
  return 'unknown';
}

function freezeRecord(value: Record<string, unknown>): Readonly<Record<string, unknown>> {
  return Object.freeze(value);
}

function lowerRenderPipeline(
  descriptor: RHIRenderPipelineDescriptor,
  owner: WebGPUDeviceOwner
): Readonly<Record<string, unknown>> {
  const lowered: Record<string, unknown> = { ...descriptor };
  if (descriptor.layout !== undefined) lowered.layout = getWebGPUNativeHandle(descriptor.layout, owner);
  if (descriptor.vertex !== undefined) {
    lowered.vertex = Object.freeze({ ...descriptor.vertex, module: getWebGPUNativeHandle(descriptor.vertex.module, owner) });
  }
  if (descriptor.fragment !== undefined) {
    lowered.fragment = Object.freeze({ ...descriptor.fragment, module: getWebGPUNativeHandle(descriptor.fragment.module, owner) });
  }
  if (descriptor.primitive !== undefined) lowered.primitive = Object.freeze({ ...descriptor.primitive });
  if (descriptor.depthStencil !== undefined) lowered.depthStencil = Object.freeze({ ...descriptor.depthStencil });
  if (descriptor.multisample !== undefined) lowered.multisample = Object.freeze({ ...descriptor.multisample });
  return freezeRecord(lowered);
}

function lowerComputePipeline(
  descriptor: RHIComputePipelineDescriptor,
  owner: WebGPUDeviceOwner
): Readonly<Record<string, unknown>> {
  const lowered: Record<string, unknown> = { ...descriptor };
  if (descriptor.layout !== undefined) lowered.layout = getWebGPUNativeHandle(descriptor.layout, owner);
  if (descriptor.compute !== undefined) {
    lowered.compute = Object.freeze({ ...descriptor.compute, module: getWebGPUNativeHandle(descriptor.compute.module, owner) });
  }
  return freezeRecord(lowered);
}
