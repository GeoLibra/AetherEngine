import type { WebGPUNativeAdapterPort } from '../webgpu/native-types';

export type NativeDawnBackend = 'metal' | 'vulkan' | 'd3d12';

export interface NativeDawnFactsPort {
  readonly version: string;
  readonly backend: NativeDawnBackend;
}

export interface NativeDawnAdapterPort extends WebGPUNativeAdapterPort {
  readonly dawn: NativeDawnFactsPort;
}

export interface NativeDawnAdapterFacts {
  readonly dawnVersion: string;
  readonly nativeBackend: NativeDawnBackend;
}
