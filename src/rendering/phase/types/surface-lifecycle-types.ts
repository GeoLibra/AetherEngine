import type { RenderGraphExecutionPlan } from '../../../render-graph';
import type { RHISurface } from '../../../rhi/contracts/surface';

/** Immutable surface facts used to build an extent-specific render plan. */
export interface SurfaceRenderPlanContext {
  readonly targetId: symbol;
  readonly generation: number;
  readonly width: number;
  readonly height: number;
}

/** Dependencies for coordinating one high-level surface render attempt. */
export interface SurfaceRenderPlanRunInput {
  readonly surface: RHISurface;
  readonly build: (context: SurfaceRenderPlanContext) => RenderGraphExecutionPlan;
  readonly execute: (plan: RenderGraphExecutionPlan, context: SurfaceRenderPlanContext) => void;
}

/** Typed outcome of coordinating one surface render attempt. */
export type SurfaceRenderPlanResult =
  | {
      readonly status: 'skipped';
      readonly reason: 'surface-suspended';
      readonly generation: number;
    }
  | {
      readonly status: 'rendered';
      readonly cache: 'hit' | 'miss';
      readonly generation: number;
      readonly width: number;
      readonly height: number;
    };
