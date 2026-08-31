import type { AnyExtractorToken } from './extractor-registry';
import { snapshotRenderFieldValue } from './render-field-snapshot';
import type {
  CandidateOperation,
  ExtractorToken,
  RenderEntityId,
  RenderFieldToken,
  RenderRevision,
  RenderTombstone
} from './types';
import type { RenderWorld } from './render-world';

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
  // Sources whose previous lifecycle ends and whose replacement is published atomically.
  readonly replacedSources = new Set<unknown>();
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

  /** Ends an existing source lifecycle and allocates its replacement in this transaction. */
  replaceEntity(
    source: unknown,
    reason: RenderTombstone['reason'] = 'generation-replaced'
  ): RenderEntityId {
    this.assertOpen();
    const previous = this.world.mapEntity(source);
    this.removeEntity(previous, reason);
    this.replacedSources.add(source);
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
    // Take ownership before adding any candidate maps. A rejected caller value must be a true
    // no-op, so commit can neither remove an existing field nor publish a provisional entity.
    const retainedOperation =
      operation.kind === 'upsert'
        ? Object.freeze({
            kind: 'upsert' as const,
            value: snapshotRenderFieldValue(operation.value)
          })
        : Object.freeze({ kind: 'remove' as const });
    const fields = this.candidates.get(entity) ?? new Map();
    this.candidates.set(entity, fields);
    const candidates = fields.get(field) ?? new Map();
    fields.set(field, candidates);
    candidates.set(owner.id, Object.freeze({ extractor: owner, operation: retainedOperation }));
  }

  private assertOpen(): void {
    if (this.committed) throw new Error('Extract transaction is already committed.');
  }
}

/**
 * Scoped draft proxy restricting writes strictly to declared extractor token fields.
 */
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
