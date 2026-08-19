import type { MonotonicClock } from '../../core/clock';

export type { MonotonicClock } from '../../core/clock';

/**
 * Unique identifier brand for an ECS World instance.
 *
 * Prevents cross-world handle mixing and validates entity ownership boundaries.
 */
export type WorldId = number & { readonly __worldId: unique symbol };

/**
 * Lifecycle execution state of an ECS World container.
 */
export type WorldState = 'created' | 'running' | 'clearing' | 'destroyed';

/**
 * Configuration options for initializing an ECS World.
 */
export interface WorldOptions {
  /**
   * Optional monotonic clock implementation for observer timing and diagnostics.
   * Defaults to a zero-offset baseline clock if omitted.
   */
  readonly clock?: MonotonicClock;
}

/**
 * Immutable diagnostic snapshot of ECS World storage and runtime metrics.
 */
export interface WorldMetricsSnapshot {
  /**
   * Number of currently alive entities across all tables and sparse stores.
   */
  readonly aliveEntities: number;

  /**
   * Total number of unique archetype tables allocated.
   */
  readonly tables: number;

  /**
   * Total number of memory chunks allocated across all archetype tables.
   */
  readonly chunks: number;

  /**
   * Total row capacity reserved across all allocated chunks.
   */
  readonly allocatedRows: number;

  /**
   * Active entity row count currently stored across all archetype tables.
   */
  readonly liveRows: number;

  /**
   * Number of archetype transitions performed during entity component modifications.
   */
  readonly migrations: number;

  /**
   * Cache hits during archetype transition graph traversal.
   */
  readonly archetypeEdgeHits: number;

  /**
   * Cache misses requiring new archetype transition graph edge creation.
   */
  readonly archetypeEdgeMisses: number;

  /**
   * Total number of query cache hits for archetype table matching.
   */
  readonly queryCacheHits: number;

  /**
   * Number of row-level filter checks evaluated during query iterations.
   */
  readonly rowFilters: number;

  /**
   * Total number of active relation edges indexed in the relation store.
   */
  readonly relationEdges: number;

  /**
   * Number of commands processed in the most recent command buffer flush.
   */
  readonly lastCommandBatchSize: number;

  /**
   * Total elapsed time in milliseconds spent executing observer callbacks.
   */
  readonly observerTimeMs: number;

  /**
   * Age of the oldest preserved removed-component tombstone record in ticks.
   */
  readonly removedLogAge: number;
}
