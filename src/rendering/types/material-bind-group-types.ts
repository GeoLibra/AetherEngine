import type {
  RHIBindGroup,
  GPUBufferBinding,
  GPUBindGroupDescriptor,
  RHIBuffer,
  RHISampler,
  RHITextureView
} from '../../rhi/contracts';
import type { DeviceLayoutRealization } from './device-layout-cache-types';
import type { BindingLayoutPlan, BindingLocation } from './binding-layout-types';
import type { BindingKeyParts, BindingResourceKeyParts, CanonicalKey } from '../pipeline-resolver';

/** Buffer-allocation lookup facts that are intentionally separate from asset resources. */
export interface MaterialBufferBindingRequest extends BindingLocation {
  readonly minimumByteSize: number;
  readonly bufferAllocationGeneration: number;
  readonly ringGeneration: number;
  readonly deviceGeneration: number;
}

/** Renderer-owned port from canonical binding identity facts to live RHI handles. */
export interface MaterialBindGroupResourceResolver {
  readonly deviceGeneration: number;
  resolveTextureView(resource: BindingResourceKeyParts): RHITextureView | undefined;
  resolveSampler(resource: BindingResourceKeyParts): RHISampler | undefined;
  resolveBuffer(request: MaterialBufferBindingRequest): GPUBufferBinding | undefined;
}

export interface MaterialBindGroupPreparationInput {
  readonly plan: BindingLayoutPlan;
  readonly deviceLayout: DeviceLayoutRealization;
  readonly bindingKey: CanonicalKey<BindingKeyParts>;
  readonly resolver: MaterialBindGroupResourceResolver;
}

/** One group-indexed descriptor ready for RHI creation. */
export interface PreparedMaterialBindGroupDescriptor {
  readonly group: number;
  readonly descriptor: Readonly<GPUBindGroupDescriptor>;
}

/** Complete immutable descriptor set; dynamic offsets are consumed later by command encoding. */
export interface PreparedMaterialBindGroups {
  readonly bindingKey: CanonicalKey<BindingKeyParts>;
  readonly groups: readonly PreparedMaterialBindGroupDescriptor[];
  readonly dynamicOffsets: readonly number[];
}

export type MaterialBindGroupDiagnosticCode =
  | 'binding-layout-incompatible'
  | 'binding-resource-missing'
  | 'binding-resource-kind-mismatch'
  | 'binding-resource-stale'
  | 'binding-buffer-range-invalid'
  | 'binding-device-generation-stale';

export interface MaterialBindGroupDiagnostic extends BindingLocation {
  readonly code: MaterialBindGroupDiagnosticCode;
  readonly message: string;
}

export type MaterialBindGroupPreparationResult =
  | { readonly status: 'ready'; readonly prepared: PreparedMaterialBindGroups }
  | { readonly status: 'unsupported'; readonly diagnostic: MaterialBindGroupDiagnostic };

/** Device-owned bind groups associated with one immutable canonical binding key. */
export interface RealizedMaterialBindGroups {
  readonly bindingKey: CanonicalKey<BindingKeyParts>;
  readonly bindGroups: readonly RHIBindGroup[];
  readonly dynamicOffsets: readonly number[];
  readonly deviceGeneration: number;
}

export interface MaterialBindGroupCacheResolution {
  readonly status: 'hit' | 'miss';
  readonly bindingSet: RealizedMaterialBindGroups;
}

/** Narrows a buffer binding after public-boundary validation. */
export type ValidatedMaterialBufferBinding = Readonly<{
  buffer: RHIBuffer;
  offset?: number;
  size?: number;
}>;
