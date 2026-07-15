import type { GPUTextureFormat } from './webgpu';

export type RHIBackend = 'webgpu' | 'webgl2' | 'native' | 'null';

export type RHIFeature =
  | 'compute'
  | 'storage-buffer'
  | 'storage-texture'
  | 'indirect-draw'
  | 'timestamp-query';

export type SupportStatus = 'native' | 'emulated' | 'unsupported';

export interface FeatureSupport {
  readonly status: SupportStatus;
  readonly reason?: string;
}

export interface RHILimits {
  readonly [name: string]: number | undefined;
}

export interface FormatCapabilities {
  readonly sample: boolean;
  readonly filter: boolean;
  readonly render: boolean;
  readonly blend: boolean;
  readonly storage: boolean;
  readonly copySrc: boolean;
  readonly copyDst: boolean;
  readonly sampleCounts: readonly number[];
}

export type RHIQueueRole = 'graphics' | 'compute' | 'transfer';

export interface QueueCapability {
  readonly role: RHIQueueRole;
  readonly status: SupportStatus;
  readonly reason?: string;
}

export interface DeviceCapabilities {
  readonly backend: RHIBackend;
  readonly features: ReadonlyMap<RHIFeature, FeatureSupport>;
  readonly limits: RHILimits;
  readonly formats: ReadonlyMap<GPUTextureFormat, FormatCapabilities>;
  readonly queues: readonly QueueCapability[];
}

export type AdapterCapabilities = DeviceCapabilities;

export type RHICapabilityRequirement =
  | { readonly kind: 'feature'; readonly feature: RHIFeature }
  | { readonly kind: 'limit'; readonly limit: string; readonly minimum: number }
  | {
      readonly kind: 'format';
      readonly format: GPUTextureFormat;
      readonly capability: Exclude<keyof FormatCapabilities, 'sampleCounts'>;
    }
  | { readonly kind: 'queue'; readonly role: RHIQueueRole };

export type RHIOperation =
  | 'create-compute-pipeline'
  | 'begin-compute-pass'
  | 'create-storage-buffer'
  | 'create-storage-texture'
  | 'draw-indirect'
  | 'timestamp-query';
