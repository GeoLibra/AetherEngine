import type {
  BufferWriteRange,
  GPUImageDataLayout,
  GPUExtent3D,
  RHIUploadData
} from './webgpu-types';
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
} from './resource-types';
import type { RHICommandEncoder, RHICommandBuffer } from './command-types';
import type { DeviceCapabilities } from './capability-types';
import type { DeviceLostInfo, RHIDeviceState } from './lifecycle-types';
import type {
  RHIBindGroupDescriptor,
  RHIBindGroupLayoutDescriptor,
  RHIBufferDescriptor,
  RHICommandEncoderDescriptor,
  RHIPipelineLayoutDescriptor,
  RHISamplerDescriptor,
  RHIShaderModuleDescriptor,
  RHITextureDescriptor
} from './descriptor-types';
import type { RHIQueueMetrics, RHISubmission } from './submission-types';
import type { RHIExtensionToken } from './extension-types';

export interface RHIQueue {
  submit(commandBuffers: readonly RHICommandBuffer[]): RHISubmission;
  metrics(): RHIQueueMetrics;
  writeBuffer(buffer: RHIBuffer, offset: number, data: RHIUploadData): void;
  writeBufferRanges(buffer: RHIBuffer, ranges: readonly BufferWriteRange[]): void;
  writeTexture(
    destination: GPUImageCopyTexture,
    data: RHIUploadData,
    dataLayout: GPUImageDataLayout,
    size: GPUExtent3D
  ): void;
}

export interface RHIDevice {
  readonly capabilities: DeviceCapabilities;
  readonly generation: number;
  readonly state: RHIDeviceState;
  readonly lost: Promise<DeviceLostInfo>;
  readonly queue: RHIQueue;
  getExtension<T>(token: RHIExtensionToken<T>): T | undefined;
  createBuffer(descriptor: RHIBufferDescriptor): RHIBuffer;
  createTexture(descriptor: RHITextureDescriptor): RHITexture;
  createSampler(descriptor?: RHISamplerDescriptor): RHISampler;
  createShaderModule(descriptor: RHIShaderModuleDescriptor): RHIShaderModule;
  createBindGroupLayout(descriptor: RHIBindGroupLayoutDescriptor): RHIBindGroupLayout;
  createPipelineLayout(descriptor: RHIPipelineLayoutDescriptor): RHIPipelineLayout;
  createBindGroup(descriptor: RHIBindGroupDescriptor): RHIBindGroup;
  createRenderPipeline(descriptor: RHIRenderPipelineDescriptor): RHIRenderPipeline;
  createComputePipeline(descriptor?: RHIComputePipelineDescriptor): RHIComputePipeline;
  createCommandEncoder(descriptor?: RHICommandEncoderDescriptor): RHICommandEncoder;
  destroy(): void;
}
