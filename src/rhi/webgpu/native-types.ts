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

export interface WebGPUNativeDevicePort {
  readonly lost: Promise<WebGPUNativeDeviceLostInfo>;
  destroy?(): void;
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
