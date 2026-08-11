import type { RenderView } from './visibility';
import {
  assertRenderGraphExecutionPlan,
  type RenderGraphExecutionPlan
} from '../render-graph/executor';

export type RenderSkipReason =
  'surface-suspended' | 'prepare-pending' | 'incompatible-pipeline' | 'missing-resource';

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

/**
 * Orchestrates the rendering pipeline for a single frame across multiple camera views.
 *
 * Execution Flow per View:
 * 1. `prepare` runs to compile shaders and upload geometries.
 * 2. If the view width or height is zero, the surface is considered suspended and downstream
 *    rendering passes are skipped to save processing time and avoid errors.
 * 3. `queue` determines visible candidates and populates rendering phases.
 * 4. `sort` groups items into coherent draw-call batches.
 * 5. `build` generates transient attachments and transitions barriers.
 * 6. `execute` records and dispatches command buffers to the GPU.
 */
export function runRenderFrame(input: {
  readonly frame: number;
  readonly views: readonly RenderView[];
  readonly stages: RenderFrameStages;
  readonly extractedEntities: number;
  readonly extractBytes: number;
}): RenderFrameMetrics {
  let prepareHits = 0,
    prepareMisses = 0,
    uploadBytes = 0,
    phaseItems = 0,
    batches = 0;
  const skipped: Record<RenderSkipReason, number> = {
    'surface-suspended': 0,
    'prepare-pending': 0,
    'incompatible-pipeline': 0,
    'missing-resource': 0
  };
  for (const view of input.views) {
    const context = Object.freeze({ frame: input.frame, view });
    const prepared = input.stages.prepare(context);
    prepareHits += prepared.hits;
    prepareMisses += prepared.misses;
    uploadBytes += prepared.uploadBytes;
    if (view.viewport.width === 0 || view.viewport.height === 0) {
      skipped['surface-suspended']++;
      continue;
    }
    const queued = input.stages.queue(context);
    phaseItems += queued.items;
    for (const reason of queued.skipped ?? []) skipped[reason]++;
    const sorted = input.stages.sort(context);
    batches += sorted.batches;
    const plan = input.stages.build(context);
    assertRenderGraphExecutionPlan(plan);
    input.stages.execute(context, plan);
  }
  return Object.freeze({
    extractedEntities: input.extractedEntities,
    extractBytes: input.extractBytes,
    prepareHits,
    prepareMisses,
    uploadBytes,
    phaseItems,
    batches,
    skipped: Object.freeze(skipped)
  });
}
