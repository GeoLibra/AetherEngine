import type { CapabilityPredicate } from '../../feature-policy';
import type { ShaderBindingManifest, ShaderStage } from '../../shader';
import type {
  BindingLayoutLoweringResult,
  BindingLayoutLoweringTarget
} from './binding-layout-lowering-types';

declare const bindingLayoutIdBrand: unique symbol;

/** Content identity of a complete canonical shader binding ABI. */
export type BindingLayoutId = string & { readonly [bindingLayoutIdBrand]: true };

/** Numeric shader resource coordinate. */
export interface BindingLocation {
  readonly group: number;
  readonly binding: number;
}

export type CanonicalBindingLayoutEntry = Readonly<
  | (BindingLocation & {
      readonly kind: 'uniform-buffer';
      readonly access: 'read';
      readonly minimumByteSize: number;
      readonly bufferLayoutHash: string;
      readonly dynamicOffset: boolean;
    })
  | (BindingLocation & {
      readonly kind: 'storage-buffer';
      readonly access: 'read' | 'read_write';
      readonly minimumByteSize: number;
      readonly bufferLayoutHash: string;
      readonly dynamicOffset: boolean;
    })
  | (BindingLocation & {
      readonly kind: 'texture';
      readonly viewDimension: '2d' | 'cube';
      readonly sampleType: 'float' | 'depth';
      readonly multisampled: boolean;
    })
  | (BindingLocation & {
      readonly kind: 'sampler';
      readonly samplerType: 'filtering' | 'non-filtering' | 'comparison';
    })
>;

export interface CanonicalBindGroupLayout {
  readonly group: number;
  readonly visibility: readonly ShaderStage[];
  readonly bindings: readonly CanonicalBindingLayoutEntry[];
}

/** Portable, immutable binding ABI consumed by target lowerers and caches. */
export interface BindingLayoutPlan {
  readonly id: BindingLayoutId;
  /** Reflection provenance used to associate Material binding paths with this canonical ABI. */
  readonly sourceLayoutHash: string;
  readonly shaderAbiVersion: number;
  readonly groups: readonly CanonicalBindGroupLayout[];
  readonly dynamicOffsetOrder: readonly BindingLocation[];
  readonly backendRequirements: readonly CapabilityPredicate[];
  readonly hash: string;
}

export interface BindingLayoutCompileOptions {
  readonly dynamicOffsetLocations?: readonly BindingLocation[];
  readonly backendRequirements?: readonly CapabilityPredicate[];
}

export type BindingLayoutDiagnosticCode =
  | 'invalid-manifest'
  | 'invalid-options'
  | 'duplicate-group'
  | 'duplicate-binding'
  | 'invalid-visibility'
  | 'missing-buffer-layout'
  | 'invalid-dynamic-offset';

export interface BindingLayoutDiagnostic {
  readonly code: BindingLayoutDiagnosticCode;
  readonly message: string;
  readonly group?: number;
  readonly binding?: number;
}

export type BindingLayoutCompileResult =
  | { readonly kind: 'success'; readonly plan: BindingLayoutPlan }
  | { readonly kind: 'invalid'; readonly diagnostic: BindingLayoutDiagnostic };

/** Purely compiles reflection facts; it never creates backend or device objects. */
export type BindingLayoutCompiler = (
  manifest: ShaderBindingManifest,
  options?: BindingLayoutCompileOptions
) => BindingLayoutCompileResult;

export interface LayoutCacheRequest {
  readonly plan: BindingLayoutPlan;
  readonly layoutRevision: number;
  readonly featurePolicyHash: string;
  readonly target: BindingLayoutLoweringTarget;
  readonly deviceGeneration: number;
}

export interface LayoutCacheEntry {
  readonly plan: BindingLayoutPlan;
  readonly layoutRevision: number;
  readonly featurePolicyHash: string;
  readonly target: BindingLayoutLoweringTarget;
  readonly deviceGeneration: number;
  readonly lowering: BindingLayoutLoweringResult;
}

export interface LayoutCacheResolution {
  readonly status: 'hit' | 'miss';
  readonly entry: LayoutCacheEntry;
}

export interface LayoutCacheMetrics {
  readonly hits: number;
  readonly misses: number;
  readonly invalidations: number;
  readonly canonicalPlans: number;
  readonly loweredEntries: number;
}
