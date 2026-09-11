import type { GPUColor } from '../../rhi/contracts';
import type { BufferUsage, TextureRange, TextureUsage } from './render-graph-types';

export type SplitReasonCode =
  | 'optimization-disabled'
  | 'non-raster-boundary'
  | 'attachment-identity-mismatch'
  | 'attachment-view-mismatch'
  | 'attachment-layout-mismatch'
  | 'intermediate-clear'
  | 'resolve-boundary'
  | 'usage-scope-conflict'
  | 'pipeline-attachment-mismatch'
  | 'depth-introduction-unproven'
  | 'synchronization-boundary'
  | 'instrumentation-boundary'
  | 'residency-budget'
  | 'group-pass-limit'
  | 'residency-estimate-unavailable';

/** Configuration options for the RenderGraph pass fusion optimizer. */
export interface PassFusionOptions {
  readonly enablePassFusion?: boolean | undefined;
  readonly maxResidencyExpansionBytes?: number | 'unlimited' | undefined;
  readonly maxGroupPassCount?: number | 'unlimited' | undefined;
}

/** Normalized and validated pass fusion options. */
export interface NormalizedFusionOptions {
  readonly enablePassFusion: boolean;
  readonly maxResidencyExpansionBytes: number | 'unlimited';
  readonly maxGroupPassCount: number | 'unlimited';
}

/** Physical execution parameters for one color attachment in a fused raster pass. */
export interface PhysicalColorAttachmentPlan {
  readonly slot: number;
  readonly resourceId: number;
  readonly range: TextureRange;
  readonly loadOp: 'load' | 'clear';
  readonly clearValue?: GPUColor | undefined;
  readonly storeOp: 'store' | 'discard';
  readonly resolveDestinationId?: number | undefined;
  readonly resolveDestinationRange?: TextureRange | undefined;
}

/** Physical execution parameters for the depth/stencil attachment in a fused raster pass. */
export interface PhysicalDepthStencilAttachmentPlan {
  readonly resourceId: number;
  readonly range: TextureRange;
  readonly depthLoadOp?: 'load' | 'clear' | undefined;
  readonly depthClearValue?: number | undefined;
  readonly depthStoreOp?: 'store' | 'discard' | undefined;
  readonly depthReadOnly?: boolean | undefined;
  readonly stencilLoadOp?: 'load' | 'clear' | undefined;
  readonly stencilClearValue?: number | undefined;
  readonly stencilStoreOp?: 'store' | 'discard' | undefined;
  readonly stencilReadOnly?: boolean | undefined;
}

/** Complete physical attachments for one fused render pass. */
export interface PhysicalAttachmentPlan {
  readonly colorAttachments: readonly PhysicalColorAttachmentPlan[];
  readonly depthStencilAttachment?: PhysicalDepthStencilAttachmentPlan | undefined;
}

/** Validated whole-group aggregate usages for all resources accessed by a group. */
export interface ValidatedGroupUsage {
  readonly textures: ReadonlyMap<number, readonly TextureUsage[]>;
  readonly buffers: ReadonlyMap<number, readonly BufferUsage[]>;
}

/** State boundary tracking for one logical member within a physical raster group. */
export interface LogicalRasterBoundaryState {
  readonly passId: number;
  readonly retainedPassIndex: number;
}

/** Complete physical plan for one fused raster pass group. */
export interface RasterGroupPlan {
  readonly groupIndex: number;
  readonly retainedPassIndices: readonly number[];
  readonly passIds: readonly number[];
  readonly attachments: PhysicalAttachmentPlan;
  readonly usageScope: ValidatedGroupUsage;
  readonly boundaryStates: readonly LogicalRasterBoundaryState[];
}

/** Recorded diagnostic reason when adjacent passes cannot be fused. */
export interface BoundarySplitRecord {
  readonly predecessorPassId: number;
  readonly candidatePassId: number;
  readonly reason: SplitReasonCode;
  readonly detail?: string | undefined;
}

/** Diagnostic counters tracking pass fusion decisions and structural results. */
export interface FusionCounters {
  readonly retainedLogicalRasterPasses: number;
  readonly physicalRasterGroups: number;
  readonly fusedBoundariesCount: number;
  readonly examinedCandidates: number;
  readonly usageComparisons: number;
  readonly stateRestorationCommands: number;
  readonly physicalLifetimeExpansionBytes: number;
  readonly peakTransientBytes: number;
}

/** Output result of the compiler pass fusion partitioning phase. */
export interface GroupPartitionResult {
  readonly groups: readonly RasterGroupPlan[];
  readonly splitRecords: readonly BoundarySplitRecord[];
  readonly counters: FusionCounters;
}
