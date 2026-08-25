import type { RenderEntityId } from '../world';
import type { RenderView } from '../visibility/types';
import {
  compareSpatialEntries,
  isSpatialEntryVisible,
  linearCullSpatialEntries
} from './linear-culler';
import {
  buildPackedStaticBvh,
  traversePackedStaticBvh,
  type MutableSpatialCounters,
  type PackedStaticBvh
} from './static-bvh';
import type {
  ReadonlySpatialEntryLookup,
  SpatialEntry,
  SpatialIndex,
  SpatialIndexSnapshot,
  SpatialQueryResult,
  SpatialUpdateBudget,
  SpatialUpdateResult,
  StaticBvhProfile
} from './types';

export class StaticBvhSpatialIndex implements SpatialIndex {
  readonly implementation = 'static-bvh-delta@1' as const;
  private readonly profile: StaticBvhProfile;
  private active: PackedStaticBvh | undefined;
  private ready: PackedStaticBvh | undefined;
  private desired = new Map<RenderEntityId, SpatialEntry>();
  private activeEntries = new Map<RenderEntityId, SpatialEntry>();
  private fallback = new Map<RenderEntityId, SpatialEntry>();
  private sourceRenderRevision = 0;
  private indexRevision = 0;
  private buildProgress = 0;
  private buildTargetOperations = 0;
  private desiredPending = 0;

  constructor(profile: StaticBvhProfile = {}) {
    this.profile = profile;
  }

  snapshot(): SpatialIndexSnapshot {
    return Object.freeze({
      implementation: this.implementation,
      indexRevision: this.indexRevision,
      sourceRenderRevision: this.sourceRenderRevision,
      entryCount: this.active?.entryCount ?? 0,
      nodeCount: this.active?.nodeCount ?? 0,
      rootNode: this.active?.rootNode ?? null,
      ...(this.active ? { checksum: this.active.checksum } : {})
    });
  }

  queueDesired(entries: readonly SpatialEntry[], renderRevision: number): void {
    const next = new Map(entries.map((entry) => [entry.renderEntity, entry]));
    this.desired = next;
    this.sourceRenderRevision = renderRevision;
    this.desiredPending = entries.length;
    this.buildProgress = 0;
    this.ready = undefined;
    this.buildTargetOperations = Math.max(1, entries.length * 2 - 1);
    this.fallback.clear();
    for (const entry of entries) {
      const indexed = this.activeEntries.get(entry.renderEntity);
      if (!indexed || indexed.boundsRevision !== entry.boundsRevision)
        this.fallback.set(entry.renderEntity, entry);
    }
  }

  applyBudget(budget: SpatialUpdateBudget): SpatialUpdateResult {
    const desiredApplied = Math.min(this.desiredPending, Math.max(0, budget.maxDesiredEntries));
    this.desiredPending -= desiredApplied;
    const operations = Math.min(
      Math.max(0, budget.maxBuildOperations),
      Math.max(0, this.buildTargetOperations - this.buildProgress)
    );
    this.buildProgress += operations;
    if (
      this.desiredPending === 0 &&
      this.buildProgress >= this.buildTargetOperations &&
      !this.ready
    ) {
      try {
        this.ready = buildPackedStaticBvh([...this.desired.values()], this.profile);
      } catch {
        return this.updateResult(desiredApplied, operations, 'failed');
      }
    }
    const state = this.ready ? 'ready-to-publish' : 'building';
    return this.updateResult(desiredApplied, operations, state);
  }

  publishReady(): boolean {
    if (!this.ready) return false;
    this.active = this.ready;
    this.ready = undefined;
    this.activeEntries = new Map(this.desired);
    this.fallback.clear();
    this.indexRevision++;
    return true;
  }

  query(
    view: RenderView,
    source: ReadonlySpatialEntryLookup | readonly SpatialEntry[]
  ): SpatialQueryResult {
    const current = materializeLookup(source);
    if (!this.active) return linearResult(view, current.values(), 'snapshot-missing');
    const counters = createCounters();
    let indexed: SpatialEntry[];
    try {
      indexed = traversePackedStaticBvh(this.active, view, current, counters);
    } catch {
      return linearResult(view, current.values(), 'snapshot-query-failed');
    }
    const merged = new Map<RenderEntityId, SpatialEntry>();
    for (const entry of indexed) merged.set(entry.renderEntity, entry);
    for (const fallbackEntry of this.fallback.values()) {
      const latest = current.get(fallbackEntry.renderEntity);
      if (!latest || latest.boundsRevision !== fallbackEntry.boundsRevision) continue;
      counters.fallbackCandidates++;
      if (!isSpatialEntryVisible(view, latest).visible) continue;
      if (merged.has(latest.renderEntity)) counters.duplicateCandidates++;
      merged.set(latest.renderEntity, latest);
    }
    const entries = Object.freeze([...merged.values()].sort(compareSpatialEntries));
    return Object.freeze({
      entities: Object.freeze(entries.map((entry) => entry.renderEntity)),
      entries,
      implementation: this.implementation,
      counters: Object.freeze(counters)
    });
  }

  private updateResult(
    desiredEntriesApplied: number,
    buildOperations: number,
    rebuildState: SpatialUpdateResult['rebuildState']
  ): SpatialUpdateResult {
    return Object.freeze({
      desiredEntriesApplied,
      buildOperations,
      pendingEntries: this.desiredPending,
      fallbackEntries: this.fallback.size,
      rebuildState
    });
  }
}

function materializeLookup(
  source: ReadonlySpatialEntryLookup | readonly SpatialEntry[]
): Map<RenderEntityId, SpatialEntry> {
  const values = Array.isArray(source) ? source : [...source.values()];
  return new Map(values.map((entry) => [entry.renderEntity, entry]));
}

function linearResult(
  view: RenderView,
  entries: Iterable<SpatialEntry>,
  fallbackReason: string
): SpatialQueryResult {
  const current = [...entries];
  const visible = linearCullSpatialEntries(view, current);
  const counters = createCounters();
  counters.fallbackCandidates = current.length;
  counters.wholeViewFallbacks = 1;
  return Object.freeze({
    entities: Object.freeze(visible.map((entry) => entry.renderEntity)),
    entries: visible,
    implementation: 'linear-scan@1',
    counters: Object.freeze(counters),
    fallbackReason
  });
}

function createCounters(): MutableSpatialCounters {
  return {
    visitedNodes: 0,
    prunedNodes: 0,
    insideNodes: 0,
    planeTests: 0,
    indexedCandidates: 0,
    staleIndexedSkipped: 0,
    fallbackCandidates: 0,
    duplicateCandidates: 0,
    wholeViewFallbacks: 0
  };
}
