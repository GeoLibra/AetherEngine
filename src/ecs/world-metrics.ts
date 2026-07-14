import type { MonotonicClock } from '../core/clock';

export type { MonotonicClock } from '../core/clock';

export interface WorldOptions { readonly clock?: MonotonicClock; }

export interface WorldMetricsSnapshot {
  readonly aliveEntities: number;
  readonly tables: number;
  readonly chunks: number;
  readonly allocatedRows: number;
  readonly liveRows: number;
  readonly migrations: number;
  readonly archetypeEdgeHits: number;
  readonly archetypeEdgeMisses: number;
  readonly queryCacheHits: number;
  readonly rowFilters: number;
  readonly relationEdges: number;
  readonly lastCommandBatchSize: number;
  readonly observerTimeMs: number;
  readonly removedLogAge: number;
}
