import type {
  GPUBufferDescriptor,
  GPUTextureDescriptor,
  RHIBuffer,
  RHITexture
} from '../../rhi/contracts';
import type { CompiledRenderGraph, PortableTransition, ResourceAliasPlan } from './compiler-types';

export type TransientResource = RHIBuffer | RHITexture;
import type { RenderGraphSnapshot } from '../builder/builder';
import type { GroupPartitionResult, RasterGroupPlan } from './fusion-types';

/** Identifies a transient texture derived from one surface configuration. */
export interface SurfaceTransientScope {
  readonly targetId: symbol;
  readonly generation: number;
  readonly width: number;
  readonly height: number;
}

/** Structural allocation counts published by a transient resource pool. */
export interface TransientResourcePoolCounters {
  readonly activeAllocations: number;
  readonly reusableAllocations: number;
  readonly retiringAllocations: number;
  readonly disposedAllocations: number;
}

export type TransientAllocationDescriptor =
  | { readonly kind: 'buffer'; readonly descriptor: GPUBufferDescriptor }
  | {
      readonly kind: 'texture';
      readonly descriptor: GPUTextureDescriptor;
      readonly surfaceScope?: SurfaceTransientScope;
    };

export type RenderGraphExecutionStep =
  | { readonly kind: 'prelude' }
  | { readonly kind: 'raster-group'; readonly groupIndex: number }
  | { readonly kind: 'pass'; readonly passId: number; readonly retainedPassIndex: number }
  | { readonly kind: 'submission' };

export interface RenderGraphExecutionPlan {
  readonly snapshot: RenderGraphSnapshot;
  readonly compiled: CompiledRenderGraph;
  readonly aliases: ResourceAliasPlan;
  readonly schedule: readonly RenderGraphExecutionStep[];
  readonly rasterGroups: readonly RasterGroupPlan[];
  /** Immutable fusion partition and diagnostics used to create this physical schedule. */
  readonly fusion: GroupPartitionResult;
  /** Portable usage transitions across passes and exports for this execution plan. */
  readonly transitions: readonly PortableTransition[];
}
