export type RenderEntityId = number & { readonly __renderEntity: unique symbol };

export interface RenderFieldToken<T> {
  readonly id: symbol;
  readonly name: string;
  readonly __value?: T;
}

export interface ExtractorToken<W extends readonly RenderFieldToken<unknown>[]> {
  readonly id: symbol;
  readonly name: string;
  readonly writes: ReadonlySet<RenderFieldToken<unknown>>;
  readonly __writes?: W;
}

export function defineRenderField<T>(name: string): RenderFieldToken<T> {
  return Object.freeze({ id: Symbol(name), name });
}

export function defineExtractorToken<const W extends readonly RenderFieldToken<unknown>[]>(
  name: string,
  writes: W
): ExtractorToken<W> {
  return Object.freeze({ id: Symbol(name), name, writes: new Set(writes) }) as ExtractorToken<W>;
}

export type RenderWorldChange =
  | { readonly kind: 'entity-added'; readonly entity: RenderEntityId }
  | { readonly kind: 'entity-removed'; readonly entity: RenderEntityId; readonly tombstone: RenderTombstone }
  | { readonly kind: 'field-added'; readonly entity: RenderEntityId; readonly field: RenderFieldToken<unknown> }
  | { readonly kind: 'field-changed'; readonly entity: RenderEntityId; readonly field: RenderFieldToken<unknown> }
  | { readonly kind: 'field-removed'; readonly entity: RenderEntityId; readonly field: RenderFieldToken<unknown> };

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
  readonly snapshot: ReadonlyMap<RenderEntityId, ReadonlyMap<RenderFieldToken<unknown>, unknown>>;
  readonly diff: RenderWorldDiff;
}

export interface RenderEntityView {
  readonly entity: RenderEntityId;
  get<T>(field: RenderFieldToken<T>): T | undefined;
}

export interface RenderQuerySpec<T> {
  readonly id: string;
  readonly reads: readonly RenderFieldToken<unknown>[];
  readonly project: (view: RenderEntityView) => T;
}

export interface RenderQuerySnapshot<T> {
  readonly queryId: string;
  readonly renderRevision: number;
  readonly items: readonly T[];
}

interface SourceEntry { readonly source: unknown; readonly entity: RenderEntityId; }
interface PendingWrite { readonly entity: RenderEntityId; readonly field: RenderFieldToken<unknown>; readonly value: unknown; }

export class RenderWorld {
  private readonly fields = new Map<RenderEntityId, Map<RenderFieldToken<unknown>, unknown>>();
  private readonly sources = new Map<unknown, SourceEntry>();
  private readonly renderGenerations = new Map<number, number>();
  private nextRenderIndex = 0;
  private currentRevision = 0;
  private lastSnapshot: RenderRevision['snapshot'] = new Map();
  private lastDiff: RenderWorldDiff = Object.freeze({ previousRevision: 0, nextRevision: 0, changes: Object.freeze([]) });

  constructor(private readonly options: { readonly requiredFields?: readonly RenderFieldToken<unknown>[] } = {}) {}

  get revision(): number { return this.currentRevision; }

  mapEntity(source: unknown): RenderEntityId {
    return this.sources.get(source)?.entity ?? this.allocateSource(source);
  }

  beginExtract(sourceTick: number, previousExtractTick: number): ExtractTransaction {
    return new ExtractTransaction(this, sourceTick, previousExtractTick);
  }

  snapshot(): RenderRevision { return Object.freeze({ revision: this.currentRevision, snapshot: this.lastSnapshot, diff: this.lastDiff }); }

  read<T>(entity: RenderEntityId, field: RenderFieldToken<T>): T | undefined {
    return this.fields.get(entity)?.get(field) as T | undefined;
  }

  query<T>(spec: RenderQuerySpec<T>): { run: (revision: RenderRevision) => RenderQuerySnapshot<T> } {
    return { run: (revision) => {
      const items: T[] = [];
      for (const [entity, values] of revision.snapshot) {
        const view: RenderEntityView = { entity, get: <V>(field: RenderFieldToken<V>) => values.get(field) as V | undefined };
        items.push(spec.project(view));
      }
      return Object.freeze({ queryId: spec.id, renderRevision: revision.revision, items: Object.freeze(items) });
    }};
  }

  private allocateSource(source: unknown): RenderEntityId {
    const index = this.nextRenderIndex++;
    const generation = (this.renderGenerations.get(index) ?? 0) + 1;
    this.renderGenerations.set(index, generation);
    const entity = (index * 0x100000 + generation) as RenderEntityId;
    this.sources.set(source, { source, entity });
    return entity;
  }

  commit(tx: ExtractTransaction): RenderRevision {
    const next = new Map<RenderEntityId, Map<RenderFieldToken<unknown>, unknown>>();
    for (const [entity, values] of this.fields) next.set(entity, new Map(values));
    for (const entity of tx.removals) next.delete(entity);
    for (const removal of tx.fieldRemovals) next.get(removal.entity)?.delete(removal.field);
    for (const write of tx.writes.values()) {
      const values = next.get(write.entity) ?? new Map();
      values.set(write.field, freezeValue(write.value));
      next.set(write.entity, values);
    }
    for (const [entity, values] of next) {
      for (const required of this.options.requiredFields ?? []) if (!values.has(required)) throw new Error(`required field "${required.name}" is missing`);
      Object.freeze(values);
    }
    const changes = diffSnapshots(this.lastSnapshot, next, tx);
    const snapshot = freezeSnapshot(next);
    this.fields.clear(); for (const [entity, values] of next) this.fields.set(entity, new Map(values));
    this.currentRevision++;
    this.lastSnapshot = snapshot;
    this.lastDiff = Object.freeze({ previousRevision: this.currentRevision - 1, nextRevision: this.currentRevision, changes: Object.freeze(changes) });
    for (const entity of tx.removals) for (const [key, entry] of this.sources) if (entry.entity === entity) { this.sources.delete(key); }
    return this.snapshot();
  }

  removeSource(entity: RenderEntityId, reason: RenderTombstone['reason'], sourceTick: number): void { /* transaction owns removal */ void entity; void reason; void sourceTick; }
}

export class ExtractTransaction {
  readonly writes = new Map<string, PendingWrite>();
  readonly fieldRemovals = new Set<{ readonly entity: RenderEntityId; readonly field: RenderFieldToken<unknown> }>();
  readonly removals = new Set<RenderEntityId>();
  private readonly owners = new Map<RenderFieldToken<unknown>, ExtractorToken<readonly RenderFieldToken<unknown>[]> >();
  constructor(private readonly world: RenderWorld, readonly sourceTick: number, readonly previousExtractTick: number) {}
  mapEntity(source: unknown): RenderEntityId { return this.world.mapEntity(source); }
  draft<W extends readonly RenderFieldToken<unknown>[]>(owner: ExtractorToken<W>): ScopedRenderDraft<W> {
    return new ScopedRenderDraft(this, owner);
  }
  removeEntity(entity: RenderEntityId, reason: RenderTombstone['reason']): void { this.removals.add(entity); this.writes.forEach((w) => { if (w.entity === entity) this.writes.delete(`${w.entity}:${w.field.id.toString()}`); }); this.removalReason = reason; }
  removalReason: RenderTombstone['reason'] = 'extract-removed';
  commit(): RenderRevision { return this.world.commit(this); }
  assertOwner(field: RenderFieldToken<unknown>, owner: ExtractorToken<readonly RenderFieldToken<unknown>[]>): void {
    if (!owner.writes.has(field)) throw new Error(`Extractor "${owner.name}" does not own field "${field.name}".`);
    const existing = this.owners.get(field); if (existing && existing !== owner) throw new Error(`Field "${field.name}" has multiple owners.`); this.owners.set(field, owner);
  }
}

export class ScopedRenderDraft<W extends readonly RenderFieldToken<unknown>[]> {
  constructor(private readonly tx: ExtractTransaction, private readonly owner: ExtractorToken<W>) {}
  upsert<K extends W[number], T = K extends RenderFieldToken<infer V> ? V : never>(entity: RenderEntityId, field: K, value: T): void { this.tx.assertOwner(field, this.owner); if (this.tx.removals.has(entity)) throw new Error('Cannot write a removed render entity.'); this.tx.writes.set(`${entity}:${field.id.toString()}`, { entity, field, value }); }
  removeField<K extends W[number]>(entity: RenderEntityId, field: K): void { this.tx.assertOwner(field, this.owner); if (this.tx.removals.has(entity)) throw new Error('Cannot edit a removed render entity.'); this.tx.fieldRemovals.add({ entity, field }); this.tx.writes.delete(`${entity}:${field.id.toString()}`); }
}

class FrozenMap<K, V> {
  constructor(private readonly inner: Map<K, V>) {}
  get size(): number { return this.inner.size; }
  get(key: K): V | undefined { return this.inner.get(key); }
  has(key: K): boolean { return this.inner.has(key); }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void { this.inner.forEach((value, key) => callbackfn.call(thisArg, value, key, this as unknown as ReadonlyMap<K, V>)); }
  *entries(): IterableIterator<[K, V]> { yield* this.inner.entries(); }
  *keys(): IterableIterator<K> { yield* this.inner.keys(); }
  *values(): IterableIterator<V> { yield* this.inner.values(); }
  [Symbol.iterator](): IterableIterator<[K, V]> { return this.entries(); }
}
function freezeValue(value: unknown): unknown { return Array.isArray(value) ? Object.freeze([...value]) : value; }
function freezeSnapshot(input: Map<RenderEntityId, Map<RenderFieldToken<unknown>, unknown>>): RenderRevision['snapshot'] { const output = new Map<RenderEntityId, ReadonlyMap<RenderFieldToken<unknown>, unknown>>(); for (const [entity, values] of input) output.set(entity, new FrozenMap(values) as unknown as ReadonlyMap<RenderFieldToken<unknown>, unknown>); return new FrozenMap(output) as unknown as RenderRevision['snapshot']; }
function diffSnapshots(previous: RenderRevision['snapshot'], next: Map<RenderEntityId, Map<RenderFieldToken<unknown>, unknown>>, tx: ExtractTransaction): RenderWorldChange[] { const changes: RenderWorldChange[] = []; const entities = new Set([...previous.keys(), ...next.keys()]); for (const entity of [...entities].sort((a,b)=>a-b)) { const before=previous.get(entity); const after=next.get(entity); if (!before && after) { changes.push({kind:'entity-added',entity}); continue; } if (before && !after) { changes.push({kind:'entity-removed',entity,tombstone:Object.freeze({sourceTick:tx.sourceTick,reason:tx.removalReason})}); continue; } if (!before || !after) continue; const fields=new Set([...before.keys(),...after.keys()]); for (const field of [...fields].sort((a,b)=>a.name.localeCompare(b.name))) { if (!before.has(field)) changes.push({kind:'field-added',entity,field}); else if (!after.has(field)) changes.push({kind:'field-removed',entity,field}); else if (JSON.stringify(before.get(field)) !== JSON.stringify(after.get(field))) changes.push({kind:'field-changed',entity,field}); } } return changes.sort((a,b)=>changeRank(a.kind)-changeRank(b.kind)); }
function changeRank(kind: RenderWorldChange['kind']): number { return kind === 'entity-added' ? 0 : kind === 'entity-removed' ? 1 : kind === 'field-added' ? 2 : kind === 'field-changed' ? 3 : 4; }
