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

let nextWebGPUGeneration = 1;

export class WebGPUDevice implements RHIDevice {
  readonly generation = nextWebGPUGeneration++;
  readonly queue: RHIQueue = new PendingWebGPUQueue();
  readonly lost: Promise<DeviceLostInfo>;

  private currentState: RHIDeviceState = 'live';
  private resolveLost!: (info: DeviceLostInfo) => void;

  constructor(
    readonly capabilities: DeviceCapabilities,
    private readonly native: WebGPUNativeDevicePort
  ) {
    this.lost = new Promise((resolve) => { this.resolveLost = resolve; });
    void native.lost.then((info) => this.handleNativeLoss(info));
  }

  get state(): RHIDeviceState {
    return this.currentState;
  }

  createBuffer(_descriptor: RHIBufferDescriptor): RHIBuffer { return pending('createBuffer'); }
  createTexture(_descriptor: RHITextureDescriptor): RHITexture { return pending('createTexture'); }
  createSampler(_descriptor: RHISamplerDescriptor = {}): RHISampler { return pending('createSampler'); }
  createShaderModule(_descriptor: RHIShaderModuleDescriptor): RHIShaderModule { return pending('createShaderModule'); }
  createBindGroupLayout(_descriptor: RHIBindGroupLayoutDescriptor): RHIBindGroupLayout { return pending('createBindGroupLayout'); }
  createPipelineLayout(_descriptor: RHIPipelineLayoutDescriptor): RHIPipelineLayout { return pending('createPipelineLayout'); }
  createBindGroup(_descriptor: RHIBindGroupDescriptor): RHIBindGroup { return pending('createBindGroup'); }
  createRenderPipeline(_descriptor: RHIRenderPipelineDescriptor): RHIRenderPipeline { return pending('createRenderPipeline'); }
  createComputePipeline(_descriptor: RHIComputePipelineDescriptor = {}): RHIComputePipeline { return pending('createComputePipeline'); }
  createCommandEncoder(_descriptor: RHICommandEncoderDescriptor = {}): RHICommandEncoder { return pending('createCommandEncoder'); }

  destroy(): void {
    if (this.currentState === 'destroyed') return;
    this.currentState = 'destroyed';
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
    this.resolveLost(Object.freeze({
      reason: normalizeLossReason(info.reason),
      message: info.message ?? 'WebGPU device was lost.',
      generation: this.generation
    }));
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
