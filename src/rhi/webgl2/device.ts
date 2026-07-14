import type { DeviceCapabilities } from '../capability-types';
import type { RHICommandEncoder } from '../command-types';
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
import type { RHIExtensionToken } from '../extension-types';
import type { DeviceLostInfo, RHIDeviceState } from '../lifecycle-types';
import type {
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
import type { RHICommandBuffer } from '../command-types';
import type { GPUImageCopyTexture } from '../resource-types';
import type { RHIQueueMetrics, RHISubmission } from '../submission-types';
import type { BufferWriteRange, GPUExtent3D, GPUImageDataLayout, RHIUploadData } from '../webgpu-types';
import type { WebGL2NativeContextLostInfo, WebGL2NativeContextPort } from './native-types';

let nextWebGL2Generation = 1;

export class WebGL2Device implements RHIDevice {
  readonly generation = nextWebGL2Generation++;
  readonly queue: RHIQueue = new PendingWebGL2Queue();
  readonly lost: Promise<DeviceLostInfo>;
  private currentState: RHIDeviceState = 'live';
  private resolveLost!: (info: DeviceLostInfo) => void;
  private nativeDestroyed = false;

  constructor(
    readonly capabilities: DeviceCapabilities,
    private readonly native: WebGL2NativeContextPort
  ) {
    this.lost = new Promise((resolve) => { this.resolveLost = resolve; });
    void native.lost.then((info) => this.handleNativeLoss(info));
  }

  get state(): RHIDeviceState { return this.currentState; }
  getExtension<T>(_token: RHIExtensionToken<T>): T | undefined { return undefined; }
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
    const wasLive = this.currentState === 'live';
    this.currentState = 'destroyed';
    this.destroyNativeOnce();
    if (wasLive) {
      this.resolveLost(Object.freeze({
        reason: 'destroyed', message: 'WebGL2Device was destroyed.', generation: this.generation
      }));
    }
  }

  private handleNativeLoss(info: WebGL2NativeContextLostInfo): void {
    if (this.currentState !== 'live') return;
    this.currentState = 'lost';
    this.resolveLost(Object.freeze({
      reason: info.reason === 'out-of-memory' ? 'out-of-memory' : 'context-lost',
      message: info.message ?? 'WebGL2 context was lost.',
      generation: this.generation
    }));
  }

  private destroyNativeOnce(): void {
    if (this.nativeDestroyed) return;
    this.nativeDestroyed = true;
    this.native.destroy?.();
  }
}

class PendingWebGL2Queue implements RHIQueue {
  submit(_commandBuffers: readonly RHICommandBuffer[]): RHISubmission { return pending('queue.submit'); }
  metrics(): RHIQueueMetrics { return pending('queue.metrics'); }
  writeBuffer(_buffer: RHIBuffer, _offset: number, _data: RHIUploadData): void { return pending('queue.writeBuffer'); }
  writeBufferRanges(_buffer: RHIBuffer, _ranges: readonly BufferWriteRange[]): void { return pending('queue.writeBufferRanges'); }
  writeTexture(
    _destination: GPUImageCopyTexture,
    _data: RHIUploadData,
    _dataLayout: GPUImageDataLayout,
    _size: GPUExtent3D
  ): void { return pending('queue.writeTexture'); }
}

function pending<T>(operation: string): T {
  throw new Error(`WebGL2 backend operation ${operation} is not implemented yet.`);
}
