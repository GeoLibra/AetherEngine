import type {
  BufferWriteRange,
  GPUBindGroupLayoutDescriptor,
  GPUBufferDescriptor,
  GPUCommandEncoderDescriptor,
  GPUImageDataLayout,
  GPUSamplerDescriptor,
  GPUShaderModuleDescriptor,
  GPUSupportedLimits,
  GPUTextureDescriptor,
  GPUExtent3D,
  RHIUploadData
} from './webgpu-types';
import type {
  GPUBindGroupDescriptor,
  GPUImageCopyTexture,
  GPUPipelineLayoutDescriptor,
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
import type { RHIRenderTarget, RenderTargetDescriptor } from './render-target-types';
import type { DeviceCapabilities } from './capability-types';
import type { DeviceLostInfo, RHIDeviceState } from './lifecycle-types';

export interface RHIQueue {
  submit(commandBuffers: readonly RHICommandBuffer[]): void;
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
  readonly features: ReadonlySet<string>;
  readonly limits: GPUSupportedLimits;
  createBuffer(descriptor: GPUBufferDescriptor): RHIBuffer;
  createTexture(descriptor: GPUTextureDescriptor): RHITexture;
  createSampler(descriptor?: GPUSamplerDescriptor): RHISampler;
  createShaderModule(descriptor: GPUShaderModuleDescriptor): RHIShaderModule;
  createBindGroupLayout(descriptor: GPUBindGroupLayoutDescriptor): RHIBindGroupLayout;
  createPipelineLayout(descriptor: GPUPipelineLayoutDescriptor): RHIPipelineLayout;
  createBindGroup(descriptor: GPUBindGroupDescriptor): RHIBindGroup;
  createRenderPipeline(descriptor: RHIRenderPipelineDescriptor): RHIRenderPipeline;
  createComputePipeline(descriptor?: RHIComputePipelineDescriptor): RHIComputePipeline;
  createRenderTarget(descriptor: RenderTargetDescriptor): RHIRenderTarget;
  createCommandEncoder(descriptor?: GPUCommandEncoderDescriptor): RHICommandEncoder;
  destroy(): void;
}
