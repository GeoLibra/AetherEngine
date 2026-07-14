import type {
  GPUBindGroupLayoutDescriptor,
  GPUBufferDescriptor,
  GPUCommandBufferDescriptor,
  GPUCommandEncoderDescriptor,
  GPUComputePassDescriptor,
  GPUSamplerDescriptor,
  GPUShaderModuleDescriptor,
  GPUTextureDescriptor,
  GPUTextureViewDescriptor
} from './webgpu-types';
import type { GPUBindGroupDescriptor, GPUPipelineLayoutDescriptor } from './resource-types';

/** Canonical portable names; these descriptors contain values or RHI handles only. */
export type RHIBufferDescriptor = GPUBufferDescriptor;
export type RHITextureDescriptor = GPUTextureDescriptor;
export type RHITextureViewDescriptor = GPUTextureViewDescriptor;
export type RHISamplerDescriptor = GPUSamplerDescriptor;
export type RHIShaderModuleDescriptor = GPUShaderModuleDescriptor;
export type RHIBindGroupLayoutDescriptor = GPUBindGroupLayoutDescriptor;
export type RHIBindGroupDescriptor = GPUBindGroupDescriptor;
export type RHIPipelineLayoutDescriptor = GPUPipelineLayoutDescriptor;
export type RHICommandEncoderDescriptor = GPUCommandEncoderDescriptor;
export type RHICommandBufferDescriptor = GPUCommandBufferDescriptor;
export type RHIComputePassDescriptor = GPUComputePassDescriptor;
