import type { FormatCapabilities, RHIFeature, RHILimits } from '../capability-types';
import type { GPUTextureFormat } from '../webgpu-types';

export interface WebGPUNativeAdapterInfo {
  readonly name: string;
  readonly vendor?: string;
  readonly architecture?: string;
}

export interface WebGPUNativeDeviceRequest {
  readonly label?: string;
  readonly requiredFeatures: readonly string[];
  readonly requiredLimits: RHILimits;
}

export interface WebGPUNativeDeviceLostInfo {
  readonly reason?: string;
  readonly message?: string;
}

export interface WebGPUNativeResourcePort {
  destroy?(): void;
  mapAsync?(mode: number, offset: number, size: number): Promise<void>;
  getMappedRange?(offset: number, size: number): ArrayBuffer;
  unmap?(): void;
}

export interface WebGPUNativeTexturePort extends WebGPUNativeResourcePort {
  createView(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeResourcePort;
}

export interface WebGPUNativeDevicePort {
  readonly lost: Promise<WebGPUNativeDeviceLostInfo>;
  destroy?(): void;
  createBuffer?(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeResourcePort;
  createTexture?(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeTexturePort;
  createSampler?(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeResourcePort;
  createShaderModule?(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeResourcePort;
  createBindGroupLayout?(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeResourcePort;
  createPipelineLayout?(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeResourcePort;
  createBindGroup?(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeResourcePort;
  createRenderPipeline?(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeResourcePort;
  createComputePipeline?(descriptor: Readonly<Record<string, unknown>>): WebGPUNativeResourcePort;
}

export interface WebGPUNativeAdapterPort {
  readonly info: WebGPUNativeAdapterInfo;
  readonly features: ReadonlySet<string>;
  readonly limits: RHILimits;
  readonly formats: ReadonlyMap<GPUTextureFormat, FormatCapabilities>;
  requestDevice(request: WebGPUNativeDeviceRequest): Promise<WebGPUNativeDevicePort>;
}

export const WEBGPU_CORE_FEATURES: readonly RHIFeature[] = Object.freeze([
  'compute',
  'storage-buffer',
  'storage-texture',
  'indirect-draw'
]);
