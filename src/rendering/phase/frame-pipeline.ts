import type { RenderView } from '../visibility/types';
import {
  assertRenderGraphExecutionPlan,
  type RenderGraphExecutionPlan
} from '../../render-graph/executor';
import type {
  RenderFrameMetrics,
  RenderFrameStageContext,
  RenderFrameStages,
  RenderSkipReason,
  RenderViewFrameOutcome
} from './types';

export type {
  RenderFrameMetrics,
  RenderFrameStageContext,
  RenderFrameStages,
  RenderSkipReason,
  RenderViewFrameOutcome
} from './types';

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
  const outcomes: RenderViewFrameOutcome[] = [];
  for (const view of input.views) {
    const context = Object.freeze({ frame: input.frame, view });
    const prepared = input.stages.prepare(context);
    prepareHits += prepared.hits;
    prepareMisses += prepared.misses;
    uploadBytes += prepared.uploadBytes;
    if (view.viewport.width === 0 || view.viewport.height === 0) {
      skipped['surface-suspended']++;
      outcomes.push(
        Object.freeze({ viewId: view.id, status: 'skipped', reason: 'surface-suspended' })
      );
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
    outcomes.push(Object.freeze({ viewId: view.id, status: 'rendered' }));
  }
  return Object.freeze({
    extractedEntities: input.extractedEntities,
    extractBytes: input.extractBytes,
    prepareHits,
    prepareMisses,
    uploadBytes,
    phaseItems,
    batches,
    skipped: Object.freeze(skipped),
    outcomes: Object.freeze(outcomes)
  });
}
