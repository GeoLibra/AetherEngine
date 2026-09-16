import type { RenderView } from '../../visibility/types';
import type { RenderGraphExecutionPlan } from '../../../render-graph';

export type RenderSkipReason =
  'surface-suspended' | 'prepare-pending' | 'incompatible-pipeline' | 'missing-resource';

/** Records whether one view reached graph execution or stopped at a typed compatibility boundary. */
export type RenderViewFrameOutcome =
  | { readonly viewId: string; readonly status: 'rendered' }
  | { readonly viewId: string; readonly status: 'skipped'; readonly reason: RenderSkipReason };

/**
 * Diagnostic metrics accumulated over the course of rendering a single frame.
 */
export interface RenderFrameMetrics {
  readonly extractedEntities: number;
  readonly extractBytes: number;
  readonly prepareHits: number;
  readonly prepareMisses: number;
  readonly uploadBytes: number;
  readonly phaseItems: number;
  readonly batches: number;
  readonly skipped: Readonly<Record<RenderSkipReason, number>>;
  readonly outcomes: readonly RenderViewFrameOutcome[];
}

export interface RenderFrameStageContext {
  readonly frame: number;
  readonly view: RenderView;
}

/**
 * Declares the structured pipeline execution steps that plugins or backends must implement.
 */
export interface RenderFrameStages {
  // Parse, build, or fetch GPU-facing resources and cache them.
  prepare(context: RenderFrameStageContext): { hits: number; misses: number; uploadBytes: number };
  // Queue visible items for drawing. Can report reasons for skipped items.
  queue(context: RenderFrameStageContext): { items: number; skipped?: readonly RenderSkipReason[] };
  // Group and sort queued draw items into cache-coherent drawing batches.
  sort(context: RenderFrameStageContext): { batches: number };
  // Build the compiled render graph for transient resource bindings and barriers.
  build(context: RenderFrameStageContext): RenderGraphExecutionPlan;
  // Execute drawing commands via RHI encoder buffers.
  execute(context: RenderFrameStageContext, plan: RenderGraphExecutionPlan): void;
}
