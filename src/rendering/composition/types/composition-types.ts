import type { FeaturePolicyCacheInvalidation } from '../../../feature-policy';

export type CompositionLoadOp = 'clear' | 'load' | 'discard';
export type CompositionDepthLoadOp = CompositionLoadOp | 'none';

/** Immutable surface facts used to compile one composition revision. Extents are physical pixels. */
export interface CompositionSurfaceSnapshot {
  readonly id: string;
  readonly generation: number;
  readonly width: number;
  readonly height: number;
  readonly format: string;
  readonly suspended?: boolean;
}

/** One ordered view contribution to a composition target. */
export interface CompositionSlotInput {
  readonly id: string;
  readonly viewId: string;
  readonly targetId: string;
  /** Top-left-origin viewport in non-negative physical pixels. */
  readonly viewportPixels: Readonly<{ x: number; y: number; width: number; height: number }>;
  readonly colorLoad: CompositionLoadOp;
  readonly depthLoad: CompositionDepthLoadOp;
  /** Whether attachment content remains valid after this slot finishes. */
  readonly stores: Readonly<{ color: boolean; depth: boolean }>;
  readonly enabled?: boolean;
  /** Relative order within one target; equal-order overlapping writes are invalid. */
  readonly order: number;
  readonly present?: boolean;
}

/** Caller-owned input copied by the composition compiler. */
export interface CompositionPlanInput {
  readonly id: string;
  readonly revision: number;
  readonly policyHash: string;
  readonly surfaces: readonly CompositionSurfaceSnapshot[];
  readonly slots: readonly CompositionSlotInput[];
}

/** Canonical enabled slot published by the compiler. */
export interface CompositionSlot extends CompositionSlotInput {
  readonly enabled: boolean;
}

/** Immutable cross-view intent consumed by RenderGraph lowering. */
export interface CompositionPlan {
  readonly id: string;
  readonly revision: number;
  readonly policyHash: string;
  readonly surfaces: readonly CompositionSurfaceSnapshot[];
  readonly slots: readonly CompositionSlot[];
  readonly presentOwners: ReadonlyMap<string, string>;
  readonly hash: string;
}

export type CompositionDiagnosticCode =
  | 'duplicate-slot-id'
  | 'ambiguous-slot-order'
  | 'load-without-content'
  | 'store-required'
  | 'surface-present-owner-missing'
  | 'surface-present-owner-duplicate'
  | 'surface-suspended'
  | 'viewport-out-of-bounds';

export interface CompositionPlanCacheResult {
  readonly status: 'hit' | 'compiled';
  readonly plan: CompositionPlan;
}

export interface CompositionPlanInvalidationConsumer {
  invalidate(invalidations: readonly FeaturePolicyCacheInvalidation[]): void;
}
