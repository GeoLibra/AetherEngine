import type { RenderEntityId } from '../../render-world';
import type { RenderView, WorldBounds } from './visibility-contract-types';

export interface SpatialEntry {
  readonly renderEntity: RenderEntityId;
  readonly boundsRevision: number;
  readonly bounds: WorldBounds;
  readonly layerMask: number;
  readonly enabled: boolean;
  readonly insertionOrder: number;
}

export interface SpatialIndexSnapshot {
  readonly implementation: 'static-bvh-delta@1';
  readonly indexRevision: number;
  readonly sourceRenderRevision: number;
  readonly entryCount: number;
  readonly nodeCount: number;
  readonly rootNode: number | null;
  readonly checksum?: number;
}

export interface SpatialQueryCounters {
  readonly visitedNodes: number;
  readonly prunedNodes: number;
  readonly insideNodes: number;
  readonly planeTests: number;
  readonly indexedCandidates: number;
  readonly staleIndexedSkipped: number;
  readonly fallbackCandidates: number;
  readonly duplicateCandidates: number;
  readonly wholeViewFallbacks: number;
}

export interface SpatialQueryResult {
  readonly entities: readonly RenderEntityId[];
  readonly entries: readonly SpatialEntry[];
  readonly implementation: 'linear-scan@1' | 'static-bvh-delta@1';
  readonly counters: SpatialQueryCounters;
  readonly fallbackReason?: string;
}

export interface SpatialUpdateBudget {
  readonly maxDesiredEntries: number;
  readonly maxBuildOperations: number;
  readonly softDeadlineMs?: number;
}

export interface SpatialUpdateResult {
  readonly desiredEntriesApplied: number;
  readonly buildOperations: number;
  readonly pendingEntries: number;
  readonly fallbackEntries: number;
  readonly rebuildState: 'idle' | 'building' | 'ready-to-publish' | 'failed';
  readonly publishedIndexRevision?: number;
}

export interface ReadonlySpatialEntryLookup {
  get(renderEntity: RenderEntityId): SpatialEntry | undefined;
  values(): Iterable<SpatialEntry>;
}

export interface SpatialIndex {
  readonly implementation: 'static-bvh-delta@1';
  snapshot(): SpatialIndexSnapshot;
  queueDesired(entries: readonly SpatialEntry[], renderRevision: number): void;
  applyBudget(budget: SpatialUpdateBudget): SpatialUpdateResult;
  publishReady(): boolean;
  query(
    view: RenderView,
    current: ReadonlySpatialEntryLookup | readonly SpatialEntry[]
  ): SpatialQueryResult;
}

export interface StaticBvhProfile {
  readonly leafSize?: number;
  readonly maxDepth?: number;
}
