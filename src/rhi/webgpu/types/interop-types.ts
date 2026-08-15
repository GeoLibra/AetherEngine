import type { RHICommandEncoder } from '../../contracts/command';
import type { RHIBufferDescriptor, RHITextureDescriptor } from '../../contracts/descriptor';
import type {
  RHIBindGroup,
  RHIBuffer,
  RHIComputePipeline,
  RHIRenderPipeline,
  RHISampler,
  RHITexture,
  RHITextureView
} from '../../contracts/resource';
import type {
  WebGPUNativeBufferPort,
  WebGPUNativeCommandEncoderPort,
  WebGPUNativeDevicePort,
  WebGPUNativeImportTexturePort,
  WebGPUNativeResourcePort
} from './native-types';

export interface WebGPUNativeResourceMap {
  readonly buffer: WebGPUNativeBufferPort;
  readonly texture: WebGPUNativeImportTexturePort;
  readonly textureView: WebGPUNativeResourcePort;
  readonly sampler: WebGPUNativeResourcePort;
  readonly bindGroup: WebGPUNativeResourcePort;
  readonly renderPipeline: WebGPUNativeResourcePort;
  readonly computePipeline: WebGPUNativeResourcePort;
}

export interface RHINativeResourceMap {
  readonly buffer: RHIBuffer;
  readonly texture: RHITexture;
  readonly textureView: RHITextureView;
  readonly sampler: RHISampler;
  readonly bindGroup: RHIBindGroup;
  readonly renderPipeline: RHIRenderPipeline;
  readonly computePipeline: RHIComputePipeline;
}

export type WebGPUNativeKind = keyof WebGPUNativeResourceMap;
export type WebGPUNativeImportKind = Extract<WebGPUNativeKind, 'buffer' | 'texture'>;
export type WebGPUInteropSubmissionPolicy = 'aether-owned-submission' | 'independent-submission';

export interface NativeImportDescriptorMap {
  readonly buffer: RHIBufferDescriptor;
  readonly texture: RHITextureDescriptor;
}

export interface WebGPUInterop {
  readonly deviceGeneration: number;
  createScope(owner: string, submissionPolicy?: WebGPUInteropSubmissionPolicy): WebGPUInteropScope;
}

export interface WebGPUInteropScope {
  readonly owner: string;
  readonly device: WebGPUNativeDevicePort;
  importBorrowed<K extends WebGPUNativeImportKind>(
    kind: K,
    resource: WebGPUNativeResourceMap[K],
    descriptor: NativeImportDescriptorMap[K]
  ): RHINativeResourceMap[K];
  adopt<K extends WebGPUNativeImportKind>(
    kind: K,
    resource: WebGPUNativeResourceMap[K],
    descriptor: NativeImportDescriptorMap[K]
  ): RHINativeResourceMap[K];
  unwrapResource<K extends WebGPUNativeKind>(
    kind: K,
    resource: RHINativeResourceMap[K]
  ): WebGPUNativeResourceMap[K];
  unwrapEncoder(encoder: RHICommandEncoder): WebGPUNativeCommandEncoderPort;
  dispose(): void;
}
