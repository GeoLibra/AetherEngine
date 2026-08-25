import type { PersistentEntityMap, RenderEntityFields } from '../persistent-entity-map';
import type { AnyExtractorToken, RenderExtractorPlan } from '../extractor-registry';

/** Nominal type for unique RenderWorld entity IDs. */
export type RenderEntityId = number & { readonly __renderEntity: unique symbol };

/**
 * Strongly-typed field token for RenderWorld ECS synchronization.
 */
export interface RenderFieldToken<T> {
  readonly id: symbol;
  readonly name: string;
  readonly compare?: (previous: unknown, next: unknown) => boolean;
  readonly __value?: T;
}

/**
 * Specialized zero-payload tag token for entity classification and fast filtering.
 */
export interface RenderTagToken extends RenderFieldToken<true> {
  readonly __tag: true;
}

/**
 * Token declaring field ownership and extractor write boundaries.
 */
export interface ExtractorToken<W extends readonly RenderFieldToken<unknown>[]> {
  readonly id: symbol;
  readonly name: string;
  readonly writes: ReadonlySet<RenderFieldToken<unknown>>;
  readonly __writes?: W;
}

/**
 * Discriminated union of atomic mutations occurring across revision boundaries.
 */
export type RenderWorldChange =
  | { readonly kind: 'entity-added'; readonly entity: RenderEntityId }
  | {
      readonly kind: 'entity-removed';
      readonly entity: RenderEntityId;
      readonly tombstone: RenderTombstone;
    }
  | {
      readonly kind: 'field-added';
      readonly entity: RenderEntityId;
      readonly field: RenderFieldToken<unknown>;
    }
  | {
      readonly kind: 'field-changed';
      readonly entity: RenderEntityId;
      readonly field: RenderFieldToken<unknown>;
    }
  | {
      readonly kind: 'field-removed';
      readonly entity: RenderEntityId;
      readonly field: RenderFieldToken<unknown>;
    };

/**
 * Diagnostic metadata recorded when a render entity is destroyed.
 */
export interface RenderTombstone {
  readonly sourceTick: number;
  readonly reason: 'despawn' | 'extract-removed' | 'generation-replaced';
}

/**
 * Exact revision delta diff between two RenderWorld snapshots.
 */
export interface RenderWorldDiff {
  readonly previousRevision: number;
  readonly nextRevision: number;
  readonly changes: readonly RenderWorldChange[];
}

/**
 * Immutable snapshot of the RenderWorld at a specific revision tick.
 */
export interface RenderRevision {
  readonly revision: number;
  readonly snapshot: ReadonlyMap<RenderEntityId, RenderEntityFields>;
  readonly diff: RenderWorldDiff;
  readonly released: boolean;
  release(): void;
}

/**
 * Read-only view accessor for querying fields on a specific render entity.
 */
export interface RenderEntityView {
  readonly entity: RenderEntityId;
  get<T>(field: RenderFieldToken<T>): T | undefined;
}

/**
 * Specification for filtered declarative queries over a RenderWorld revision.
 */
export interface RenderQuerySpec<T> {
  readonly id: string;
  readonly reads: readonly RenderFieldToken<unknown>[];
  readonly with?: readonly RenderTagToken[];
  readonly without?: readonly RenderTagToken[];
  readonly project: (view: RenderEntityView) => T;
}

/**
 * Immutable query results captured at a specific revision tick.
 */
export interface RenderQuerySnapshot<T> {
  readonly queryId: string;
  readonly renderRevision: number;
  readonly items: readonly T[];
}

/**
 * Performance diagnostic counters tracking structural sharing copy-on-write metrics.
 */
export interface RenderWorldCounters {
  readonly copiedDirectoryNodes: number;
  readonly copiedPages: number;
  readonly comparedFields: number;
}

export interface RenderWorldOptions {
  readonly requiredFields?: readonly RenderFieldToken<unknown>[];
  readonly extractorPlan?: RenderExtractorPlan;
}

export interface SourceEntry {
  readonly source: unknown;
  readonly entity: RenderEntityId;
}

export interface CandidateOperation {
  readonly extractor: AnyExtractorToken;
  readonly operation:
    { readonly kind: 'upsert'; readonly value: unknown } | { readonly kind: 'remove' };
}

export interface RevisionRoot {
  readonly revision: number;
  readonly snapshot: PersistentEntityMap;
  readonly diff: RenderWorldDiff;
  leases: number;
}
