import type { RenderView } from './visibility';

export type RenderSkipReason =
  'surface-suspended' | 'prepare-pending' | 'incompatible-pipeline' | 'missing-resource';
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
export interface RenderFrameStages {
  prepare(context: RenderFrameStageContext): { hits: number; misses: number; uploadBytes: number };
  queue(context: RenderFrameStageContext): { items: number; skipped?: readonly RenderSkipReason[] };
  sort(context: RenderFrameStageContext): { batches: number };
  build(context: RenderFrameStageContext): void;
  execute(context: RenderFrameStageContext): void;
}

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
    input.stages.build(context);
    input.stages.execute(context);
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
