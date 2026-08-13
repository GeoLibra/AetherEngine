import {
  RenderExtractorPlan,
  type AnyExtractorToken,
  type RenderFieldCandidate
} from './extractor-registry';
import { PersistentEntityMap, type RenderEntityFields } from './persistent-entity-map';

export type RenderEntityId = number & { readonly __renderEntity: unique symbol };

export interface RenderFieldToken<T> {
  readonly id: symbol;
  readonly name: string;
  readonly compare?: (previous: unknown, next: unknown) => boolean;
  readonly __value?: T;
}
export interface RenderTagToken extends RenderFieldToken<true> {
  readonly __tag: true;
}
export interface ExtractorToken<W extends readonly RenderFieldToken<unknown>[]> {
  readonly id: symbol;
  readonly name: string;
  readonly writes: ReadonlySet<RenderFieldToken<unknown>>;
  readonly __writes?: W;
}

export function defineRenderField<T>(
  name: string,
  options: { readonly compare?: (previous: T, next: T) => boolean } = {}
): RenderFieldToken<T> {
  return Object.freeze({
    id: Symbol(name),
    name,
    ...(options.compare
      ? { compare: options.compare as (previous: unknown, next: unknown) => boolean }
      : {})
  });
}
export function defineRenderTag(name: string): RenderTagToken {
  return Object.freeze({ id: Symbol(name), name, __tag: true });
}
export function defineExtractorToken<const W extends readonly RenderFieldToken<unknown>[]>(
  name: string,
  writes: W
): ExtractorToken<W> {
  return Object.freeze({ id: Symbol(name), name, writes: new Set(writes) }) as ExtractorToken<W>;
}

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
export interface RenderTombstone {
  readonly sourceTick: number;
  readonly reason: 'despawn' | 'extract-removed' | 'generation-replaced';
}
export interface RenderWorldDiff {
  readonly previousRevision: number;
  readonly nextRevision: number;
  readonly changes: readonly RenderWorldChange[];
}
export interface RenderRevision {
  readonly revision: number;
  readonly snapshot: ReadonlyMap<RenderEntityId, RenderEntityFields>;
  readonly diff: RenderWorldDiff;
  readonly released: boolean;
  release(): void;
}
export interface RenderEntityView {
  readonly entity: RenderEntityId;
  get<T>(field: RenderFieldToken<T>): T | undefined;
}
export interface RenderQuerySpec<T> {
  readonly id: string;
  readonly reads: readonly RenderFieldToken<unknown>[];
  readonly with?: readonly RenderTagToken[];
  readonly without?: readonly RenderTagToken[];
  readonly project: (view: RenderEntityView) => T;
}
export interface RenderQuerySnapshot<T> {
  readonly queryId: string;
  readonly renderRevision: number;
  readonly items: readonly T[];
}
export interface RenderWorldCounters {
  readonly copiedDirectoryNodes: number;
  readonly copiedPages: number;
  readonly comparedFields: number;
}

interface SourceEntry {
  readonly source: unknown;
  readonly entity: RenderEntityId;
}
interface CandidateOperation {
  readonly extractor: AnyExtractorToken;
  readonly operation:
    { readonly kind: 'upsert'; readonly value: unknown } | { readonly kind: 'remove' };
}
interface RevisionRoot {
  readonly revision: number;
  readonly snapshot: PersistentEntityMap;
  readonly diff: RenderWorldDiff;
  leases: number;
}

/**
 * RenderWorld manages the stateless, derived rendering representations of ECS entities.
 * It is isolated from MainWorld logic, allowing parallel execution of logical updates
 * and rendering command recording.
 *
 * Features a double-buffering/revision system where older snapshots are preserved
 * through reference-counted leases, preventing early disposal during GPU queue submission.
 */
export class RenderWorld {
  // Maps original gameplay components/sources to their mapped RenderEntityId.
  private readonly sources = new Map<unknown, SourceEntry>();
  // Tracks all entities currently active in the latest revision.
  private readonly activeEntities = new Set<RenderEntityId>();
  // Tracks the current generation count for each slot index to prevent handle collisions.
  private readonly generations = new Map<number, number>();
  // Stores indices of despawned entities that are retired and eligible for recycling.
  private readonly retired = new Map<number, RenderEntityId>();
  private nextRenderIndex = 0;
  // The current active revision root containing the latest trie snapshot.
  private root: RevisionRoot;
  // A set of active historical roots kept alive due to outstanding leases.
  private readonly roots = new Set<RevisionRoot>();
  // The compilation plan of extractors, defining field ownership and arbitration rules.
  private readonly extractorPlan: RenderExtractorPlan;
  // Diagnostics counters tracking COW performance metrics.
  private countersValue: RenderWorldCounters = Object.freeze({
    copiedDirectoryNodes: 0,
    copiedPages: 0,
    comparedFields: 0
  });

  constructor(
    options: {
      readonly requiredFields?: readonly RenderFieldToken<unknown>[];
      readonly extractorPlan?: RenderExtractorPlan;
    } = {}
  ) {
    this.extractorPlan = options.extractorPlan ?? RenderExtractorPlan.compile([]);
    this.options = options;
    const diff = frozenDiff(0, 0, []);
    this.root = { revision: 0, snapshot: PersistentEntityMap.empty, diff, leases: 0 };
    this.roots.add(this.root);
  }

  private readonly options: { readonly requiredFields?: readonly RenderFieldToken<unknown>[] };
  get revision(): number {
    return this.root.revision;
  }
  get counters(): RenderWorldCounters {
    return this.countersValue;
  }

  /**
   * Resolves a source identity to its corresponding active RenderEntityId.
   * Throws if queried outside an extract transaction before mapping occurs.
   */
  mapEntity(source: unknown): RenderEntityId {
    const existing = this.sources.get(source)?.entity;
    if (existing !== undefined) return existing;
    throw new Error('New render entities must be mapped inside an extract transaction.');
  }

  /**
   * Spawns a transaction to extract gameplay state into the RenderWorld.
   */
  beginExtract(sourceTick: number, previousExtractTick: number): ExtractTransaction {
    return new ExtractTransaction(this, sourceTick, previousExtractTick);
  }

  /**
   * Leases the current active snapshot revision. The revision must be explicitly
   * released when it is no longer used by RHI execution to allow garbage collection.
   */
  snapshot(): RenderRevision {
    return this.lease(this.root);
  }
  acquireRevision(): RenderRevision {
    return this.snapshot();
  }

  /**
   * Directly reads a field value from the active revision.
   */
  read<T>(entity: RenderEntityId, field: RenderFieldToken<T>): T | undefined {
    return this.root.snapshot.get(entity)?.get(field) as T | undefined;
  }

  /**
   * Compiles and runs a filtered ECS query on a specific snapshot.
   * Entities are filtered in O(1) matching reads, with, and without tag filters.
   */
  query<T>(spec: RenderQuerySpec<T>): {
    run: (revision: RenderRevision) => RenderQuerySnapshot<T>;
  } {
    return {
      run: (revision) => {
        if (revision.released) throw new Error('Cannot query a released render revision.');
        const items: T[] = [];
        for (const [entity, values] of revision.snapshot) {
          if (spec.reads.some((field) => !values.has(field))) continue;
          if (spec.with?.some((tag) => !values.has(tag))) continue;
          if (spec.without?.some((tag) => values.has(tag))) continue;
          items.push(
            spec.project({
              entity,
              get: <V>(field: RenderFieldToken<V>) => values.get(field) as V | undefined
            })
          );
        }
        return Object.freeze({
          queryId: spec.id,
          renderRevision: revision.revision,
          items: Object.freeze(items)
        });
      }
    };
  }

  /**
   * Reserves a RenderEntityId slot for a new source. If a retired slot index
   * is available and not leased by any historical revision, it is recycled,
   * and its generation number is incremented.
   */
  reserveSource(tx: ExtractTransaction, source: unknown): RenderEntityId {
    const committed = this.sources.get(source)?.entity;
    if (committed !== undefined) return committed;
    const provisional = tx.provisionalSources.get(source);
    if (provisional !== undefined) return provisional;
    const index = this.findReusableIndex(tx) ?? this.nextRenderIndex + tx.newIndexCount++;
    const generation = (this.generations.get(index) ?? 0) + 1;
    // A failed transaction may have exposed this identity, so its generation is burned.
    this.generations.set(index, generation);
    const entity = packEntity(index, generation);
    tx.provisionalSources.set(source, entity);
    tx.provisionalIndices.add(index);
    return entity;
  }

  assertEntityActive(tx: ExtractTransaction, entity: RenderEntityId): void {
    if (!this.activeEntities.has(entity) && !tx.hasProvisionalEntity(entity))
      throw new Error('Cannot write a stale render entity.');
  }

  assertExtractor(extractor: AnyExtractorToken): void {
    this.extractorPlan.assertExtractor(extractor);
  }

  /**
   * Commits the transaction to publish a new Revision.
   * Performs resolution of extractor candidates via arbitrators, checks constraints,
   * constructs the new trie snapshot (using structural sharing), generates the
   * lifecycle and field-level diff, updates the entity mappings, and triggers revision cleanup.
   */
  commit(tx: ExtractTransaction): RenderRevision {
    let next = this.root.snapshot;
    let comparedFields = 0;
    const touched = new Map<RenderEntityId, Set<RenderFieldToken<unknown>>>();
    const edited = new Map<RenderEntityId, Map<RenderFieldToken<unknown>, unknown>>();
    const edit = (entity: RenderEntityId): Map<RenderFieldToken<unknown>, unknown> => {
      let values = edited.get(entity);
      if (!values) {
        values = new Map(next.get(entity));
        edited.set(entity, values);
      }
      return values;
    };

    // Apply entity despawn removals.
    for (const entity of tx.removals) next = next.delete(entity);

    // Apply field mutations and run registered field arbitrators.
    for (const [entity, fields] of tx.candidates) {
      if (tx.removals.has(entity)) continue;
      const values = edit(entity);
      for (const [field, byExtractor] of fields) {
        const ordered = [...byExtractor.values()].sort((a, b) =>
          a.extractor.name.localeCompare(b.extractor.name)
        );
        const candidates = ordered.map((candidate) =>
          Object.freeze(candidate)
        ) as readonly RenderFieldCandidate<unknown>[];
        const previous = this.root.snapshot.get(entity)?.get(field);
        const arbitrator = this.extractorPlan.arbitrator(field);
        const result = arbitrator
          ? arbitrator.resolve(candidates, previous)
          : candidates[0]?.operation.kind === 'upsert'
            ? { kind: 'publish' as const, value: candidates[0].operation.value }
            : { kind: 'remove' as const };
        if (result.kind === 'publish') values.set(field, freezeValue(result.value));
        else if (result.kind === 'remove') values.delete(field);
        else continue;
        const dirty = touched.get(entity) ?? new Set();
        dirty.add(field);
        touched.set(entity, dirty);
      }
    }

    // Verify required field constraints and update the trie.
    for (const [entity, values] of edited) {
      for (const required of this.options.requiredFields ?? [])
        if (!values.has(required)) throw new Error(`required field "${required.name}" is missing`);
      next = next.set(entity, freezeFields(values));
    }

    // Generate revision delta diff.
    const changes: RenderWorldChange[] = [];
    const entities = new Set([...tx.removals, ...touched.keys()]);
    for (const entity of [...entities].sort((a, b) => a - b)) {
      const before = this.root.snapshot.get(entity);
      const after = next.get(entity);
      if (!before && after) changes.push({ kind: 'entity-added', entity });
      else if (before && !after)
        changes.push({
          kind: 'entity-removed',
          entity,
          tombstone: Object.freeze({
            sourceTick: tx.sourceTick,
            reason: tx.removalReasons.get(entity) ?? 'extract-removed'
          })
        });
      else if (before && after)
        for (const field of [...(touched.get(entity) ?? [])].sort((a, b) =>
          a.name.localeCompare(b.name)
        )) {
          if (!before.has(field) && after.has(field))
            changes.push({ kind: 'field-added', entity, field });
          else if (before.has(field) && !after.has(field))
            changes.push({ kind: 'field-removed', entity, field });
          else if (before.has(field) && after.has(field)) {
            comparedFields++;
            const equal = field.compare
              ? field.compare(before.get(field), after.get(field))
              : Object.is(before.get(field), after.get(field)) ||
                stableValueEqual(before.get(field), after.get(field));
            if (!equal) changes.push({ kind: 'field-changed', entity, field });
          }
        }
    }
    changes.sort((a, b) => changeRank(a.kind) - changeRank(b.kind));

    // Publish every lifecycle mutation only after arbitration and validation succeeds.
    for (const [source, entity] of tx.provisionalSources) {
      this.sources.set(source, { source, entity });
      this.activeEntities.add(entity);
    }
    this.nextRenderIndex += tx.newIndexCount;
    for (const entity of tx.removals) {
      for (const [source, entry] of this.sources)
        if (entry.entity === entity) this.sources.delete(source);
      this.activeEntities.delete(entity);
      this.retired.set(unpackIndex(entity), entity);
    }

    const previousRoot = this.root;
    const revision = previousRoot.revision + 1;
    const diff = frozenDiff(previousRoot.revision, revision, changes);
    this.root = { revision, snapshot: next, diff, leases: 0 };
    this.roots.add(this.root);
    this.countersValue = Object.freeze({
      copiedDirectoryNodes: edited.size * 2,
      copiedPages: edited.size + tx.removals.size,
      comparedFields
    });
    this.collectRoots();
    return this.lease(this.root);
  }

  /**
   * Helper to create a new reference-counted lease wrapper around a revision root.
   */
  private lease(root: RevisionRoot): RenderRevision {
    root.leases++;
    let released = false;
    const world = this;
    return Object.freeze({
      revision: root.revision,
      snapshot: new FrozenMap(
        root.snapshot as unknown as ReadonlyMap<RenderEntityId, RenderEntityFields>
      ),
      diff: root.diff,
      get released() {
        return released;
      },
      release() {
        if (released) return;
        released = true;
        root.leases--;
        world.collectRoots();
      }
    });
  }

  /**
   * Searches the retired list to find a slot index that is no longer
   * referenced by the current active root or any leased historical roots.
   */
  private findReusableIndex(tx: ExtractTransaction): number | undefined {
    for (const [index] of [...this.retired].sort(([a], [b]) => a - b)) {
      if (tx.provisionalIndices.has(index)) continue;
      if (
        [...this.roots].some((root) =>
          root === this.root || root.leases > 0
            ? root.snapshot.has(this.retired.get(index)!)
            : false
        )
      )
        continue;
      this.retired.delete(index);
      return index;
    }
    return undefined;
  }

  /**
   * Prunes root nodes that are no longer active and have no outstanding leases.
   */
  private collectRoots(): void {
    for (const root of this.roots)
      if (root !== this.root && root.leases === 0) this.roots.delete(root);
  }
}

/**
 * ExtractTransaction isolates write-side buffering of game state extraction.
 * No modifications are visible to queries or subsequent render frames until
 * commit() is successfully executed.
 */
export class ExtractTransaction {
  // Collects pending field updates grouped by entity, field token, and extractor registration id.
  readonly candidates = new Map<
    RenderEntityId,
    Map<RenderFieldToken<unknown>, Map<symbol, CandidateOperation>>
  >();
  // Set of entities marked for destruction in this frame.
  readonly removals = new Set<RenderEntityId>();
  // Maps deleted entities to their tombstone removal reasons.
  readonly removalReasons = new Map<RenderEntityId, RenderTombstone['reason']>();
  // Provisional mappings for entities spawned in this transaction.
  readonly provisionalSources = new Map<unknown, RenderEntityId>();
  // Provisional index numbers reserved for recycled slots in this transaction.
  readonly provisionalIndices = new Set<number>();
  newIndexCount = 0;
  private committed = false;

  constructor(
    private readonly world: RenderWorld,
    readonly sourceTick: number,
    readonly previousExtractTick: number
  ) {}

  /**
   * Resolves or maps a new source to a RenderEntityId inside this transaction.
   */
  mapEntity(source: unknown): RenderEntityId {
    this.assertOpen();
    return this.world.reserveSource(this, source);
  }

  /**
   * Returns a typed draft scope bound to a specific registered extractor token.
   */
  draft<W extends readonly RenderFieldToken<unknown>[]>(
    owner: ExtractorToken<W>
  ): ScopedRenderDraft<W> {
    this.assertOpen();
    this.world.assertExtractor(owner as AnyExtractorToken);
    return new ScopedRenderDraft(this, owner);
  }

  /**
   * Schedules the deletion of a render entity and cancels any pending writes on it.
   */
  removeEntity(entity: RenderEntityId, reason: RenderTombstone['reason']): void {
    this.assertOpen();
    this.world.assertEntityActive(this, entity);
    this.removals.add(entity);
    this.candidates.delete(entity);
    this.removalReasons.set(entity, reason);
  }

  /**
   * Commits the buffered changes to the global RenderWorld and publishes a new snapshot.
   */
  commit(): RenderRevision {
    this.assertOpen();
    const revision = this.world.commit(this);
    this.committed = true;
    return revision;
  }

  assertEntityActive(entity: RenderEntityId): void {
    this.world.assertEntityActive(this, entity);
  }

  hasProvisionalEntity(entity: RenderEntityId): boolean {
    return [...this.provisionalSources.values()].includes(entity);
  }

  /**
   * Buffers a field operation candidate for a given extractor.
   * Throws if the extractor does not declare ownership of the field.
   */
  write(
    owner: AnyExtractorToken,
    entity: RenderEntityId,
    field: RenderFieldToken<unknown>,
    operation: CandidateOperation['operation']
  ): void {
    this.assertOpen();
    this.assertEntityActive(entity);
    if (!owner.writes.has(field))
      throw new Error(`Extractor "${owner.name}" does not own field "${field.name}".`);
    if (this.removals.has(entity)) throw new Error('Cannot edit a removed render entity.');
    const fields = this.candidates.get(entity) ?? new Map();
    this.candidates.set(entity, fields);
    const candidates = fields.get(field) ?? new Map();
    fields.set(field, candidates);
    candidates.set(owner.id, { extractor: owner, operation });
  }

  private assertOpen(): void {
    if (this.committed) throw new Error('Extract transaction is already committed.');
  }
}

export class ScopedRenderDraft<W extends readonly RenderFieldToken<unknown>[]> {
  constructor(
    private readonly tx: ExtractTransaction,
    private readonly owner: ExtractorToken<W>
  ) {}
  upsert<K extends W[number], T = K extends RenderFieldToken<infer V> ? V : never>(
    entity: RenderEntityId,
    field: K,
    value: T
  ): void {
    this.tx.write(this.owner as AnyExtractorToken, entity, field, { kind: 'upsert', value });
  }
  removeField<K extends W[number]>(entity: RenderEntityId, field: K): void {
    this.tx.write(this.owner as AnyExtractorToken, entity, field, { kind: 'remove' });
  }
}

class FrozenMap<K, V> implements ReadonlyMap<K, V> {
  constructor(private readonly inner: ReadonlyMap<K, V>) {}
  get size(): number {
    return this.inner.size;
  }
  get(key: K): V | undefined {
    return this.inner.get(key);
  }
  has(key: K): boolean {
    return this.inner.has(key);
  }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this) callbackfn.call(thisArg, value, key, this);
  }
  entries(): MapIterator<[K, V]> {
    return this.inner.entries();
  }
  keys(): MapIterator<K> {
    return this.inner.keys();
  }
  values(): MapIterator<V> {
    return this.inner.values();
  }
  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.inner.entries();
  }
  get [Symbol.toStringTag](): string {
    return 'FrozenMap';
  }
}

function freezeFields(values: Map<RenderFieldToken<unknown>, unknown>): RenderEntityFields {
  return new FrozenMap(values);
}
function freezeValue(value: unknown): unknown {
  return Array.isArray(value) ? Object.freeze([...value]) : value;
}
function stableValueEqual(left: unknown, right: unknown): boolean {
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null)
    return false;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}
function packEntity(index: number, generation: number): RenderEntityId {
  return (index * 0x100000 + generation) as RenderEntityId;
}
function unpackIndex(entity: RenderEntityId): number {
  return Math.floor(entity / 0x100000);
}
function frozenDiff(
  previousRevision: number,
  nextRevision: number,
  changes: readonly RenderWorldChange[]
): RenderWorldDiff {
  return Object.freeze({ previousRevision, nextRevision, changes: Object.freeze([...changes]) });
}
function changeRank(kind: RenderWorldChange['kind']): number {
  return kind === 'entity-added'
    ? 0
    : kind === 'entity-removed'
      ? 1
      : kind === 'field-added'
        ? 2
        : kind === 'field-changed'
          ? 3
          : 4;
}
