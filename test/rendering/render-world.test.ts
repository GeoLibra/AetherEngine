import { describe, expect, test } from 'vitest';
import {
  RenderExtractorRegistryBuilder,
  RenderWorld,
  defineExtractorToken,
  defineRenderField,
  defineRenderTag,
  type RenderEntityId,
  type RenderFieldToken
} from '../../src/rendering';

const Transform = defineRenderField<[number, number, number]>('transform');
const Visible = defineRenderField<boolean>('visible');
const Selected = defineRenderTag('selected');
const Hidden = defineRenderTag('hidden');
const extractor = defineExtractorToken('scene', [Transform, Visible, Selected, Hidden]);

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;
type RenderWorldOptions = NonNullable<ConstructorParameters<typeof RenderWorld>[0]>;
type RenderWorldOptionKeys = Expect<
  Equal<keyof RenderWorldOptions, 'requiredFields' | 'extractorPlan'>
>;

const exactRenderWorldOptions: RenderWorldOptionKeys = true;

function createWorld(requiredFields: readonly ReturnType<typeof defineRenderField>[] = []) {
  const extractorPlan = new RenderExtractorRegistryBuilder().registerExtractor(extractor).build();
  return new RenderWorld({ requiredFields, extractorPlan });
}

function publish(
  world: RenderWorld,
  tick: number,
  write: (draft: ReturnType<RenderWorld['beginExtract']>) => void
) {
  const transaction = world.beginExtract(tick, tick - 1);
  write(transaction);
  return transaction.commit();
}

describe('RenderWorld', () => {
  test('keeps constructor options exact', () => {
    expect(exactRenderWorldOptions).toBe(true);
  });

  test('publishes generation-safe mapped entities and coalesced fields', () => {
    const world = createWorld([Transform]);
    const source = 1001 as never;
    const first = publish(world, 1, (tx) => {
      const entity = tx.mapEntity(source);
      tx.draft(extractor).upsert(entity, Transform, [1, 0, 0]);
      tx.draft(extractor).upsert(entity, Transform, [2, 0, 0]);
    });

    expect(first.revision).toBe(1);
    expect(first.diff.changes.map((change) => change.kind)).toEqual(['entity-added']);
    const entity = world.mapEntity(source);
    expect(world.read(entity, Transform)).toEqual([2, 0, 0]);
    expect('set' in first.snapshot.get(entity)!).toBe(false);
    expect('set' in first.snapshot).toBe(false);
  });

  test('does not let a post-plan extractor write-set mutation authorize an undeclared field', () => {
    const Declared = defineRenderField<number>('declared');
    const Undeclared = defineRenderField<number>('undeclared');
    const owner = defineExtractorToken('declared-owner', [Declared]);
    const world = new RenderWorld({
      extractorPlan: new RenderExtractorRegistryBuilder().registerExtractor(owner).build()
    });
    const maliciousWrites = owner.writes as unknown as Set<typeof Undeclared | typeof Declared>;
    try {
      maliciousWrites.add(Undeclared);
    } catch {
      // A runtime-enforced read-only set rejects the cast-based mutation.
    }

    const tx = world.beginExtract(1, 0);
    const entity = tx.mapEntity('undeclared-write');
    const draft = tx.draft(owner) as unknown as {
      upsert(entity: RenderEntityId, field: typeof Undeclared, value: number): void;
    };

    expect(() => draft.upsert(entity, Undeclared, 1)).toThrow('does not own');
  });

  test('snapshots nested caller field values at write time and keeps public reads detached', () => {
    const Facts = defineRenderField<{
      readonly nested: readonly { readonly label: string; readonly values: readonly number[] }[];
      readonly matrix: Float32Array;
    }>('facts');
    const owner = defineExtractorToken('facts-owner', [Facts]);
    const world = new RenderWorld({
      extractorPlan: new RenderExtractorRegistryBuilder().registerExtractor(owner).build()
    });
    const source = {
      nested: [{ label: 'initial', values: [1, 2] }],
      matrix: new Float32Array([1, 2, 3, 4])
    };
    const tx = world.beginExtract(1, 0);
    const entity = tx.mapEntity('facts');
    tx.draft(owner).upsert(entity, Facts, source);
    source.nested[0]!.values[0] = 99;
    source.matrix[0] = 99;

    tx.commit().release();
    source.nested[0]!.values[1] = 88;
    source.matrix[1] = 88;

    const first = world.read(entity, Facts)!;
    expect(first).toMatchObject({ nested: [{ label: 'initial', values: [1, 2] }] });
    expect([...first.matrix]).toEqual([1, 2, 3, 4]);
    first.matrix[0] = 7;
    expect([...world.read(entity, Facts)!.matrix]).toEqual([1, 2, 3, 4]);
    expect(Object.isExtensible(source)).toBe(true);
  });

  test('rejects cyclic render field values at the write boundary', () => {
    const Facts = defineRenderField<readonly unknown[]>('cyclic-facts');
    const owner = defineExtractorToken('cyclic-owner', [Facts]);
    const world = new RenderWorld({
      extractorPlan: new RenderExtractorRegistryBuilder().registerExtractor(owner).build()
    });
    const value: unknown[] = [];
    value.push(value);
    const tx = world.beginExtract(1, 0);

    expect(() => tx.draft(owner).upsert(tx.mapEntity('cyclic'), Facts, value)).toThrow(/cycle/i);
    expect(Object.isExtensible(value)).toBe(true);
  });

  test('rejects mutable Map render field values at the write boundary', () => {
    const Facts = defineRenderField<ReadonlyMap<string, number>>('map-facts');
    const owner = defineExtractorToken('map-owner', [Facts]);
    const world = new RenderWorld({
      extractorPlan: new RenderExtractorRegistryBuilder().registerExtractor(owner).build()
    });
    const value = new Map([['one', 1]]);
    const tx = world.beginExtract(1, 0);

    expect(() => tx.draft(owner).upsert(tx.mapEntity('map'), Facts, value)).toThrow(/Map/i);
    expect(value.get('one')).toBe(1);
  });

  test('does not turn an invalid replacement write into a field removal on commit', () => {
    const Facts = defineRenderField<readonly unknown[]>('atomic-facts');
    const owner = defineExtractorToken('atomic-owner', [Facts]);
    const world = new RenderWorld({
      extractorPlan: new RenderExtractorRegistryBuilder().registerExtractor(owner).build()
    });
    let entity!: RenderEntityId;
    publish(world, 1, (tx) => {
      entity = tx.mapEntity('existing-facts');
      tx.draft(owner).upsert(entity, Facts, [1, 2]);
    });
    const invalid: unknown[] = [];
    invalid.push(invalid);
    const transaction = world.beginExtract(2, 1);

    expect(() => transaction.draft(owner).upsert(entity, Facts, invalid)).toThrow(/cycle/i);
    const revision = transaction.commit();

    expect(world.read(entity, Facts)).toEqual([1, 2]);
    expect(revision.diff.changes).toEqual([]);
    revision.release();
  });

  test('does not publish an empty entity after its first write fails validation', () => {
    const Facts = defineRenderField<readonly unknown[]>('first-invalid-facts');
    const owner = defineExtractorToken('first-invalid-owner', [Facts]);
    const world = new RenderWorld({
      extractorPlan: new RenderExtractorRegistryBuilder().registerExtractor(owner).build()
    });
    const invalid: unknown[] = [];
    invalid.push(invalid);
    const transaction = world.beginExtract(1, 0);
    const entity = transaction.mapEntity('first-invalid');

    expect(() => transaction.draft(owner).upsert(entity, Facts, invalid)).toThrow(/cycle/i);
    const revision = transaction.commit();

    expect(revision.snapshot.has(entity)).toBe(false);
    expect(revision.diff.changes).toEqual([]);
    revision.release();
  });

  test('seals revision map facades without reflectively exposing their backing maps', () => {
    const world = createWorld();
    const revision = publish(world, 1, (tx) =>
      tx.draft(extractor).upsert(tx.mapEntity('snapshot'), Transform, [1, 2, 3])
    );
    const fields = revision.snapshot.get(world.mapEntity('snapshot'))!;

    expect(Object.isFrozen(revision.snapshot)).toBe(true);
    expect(Object.isFrozen(fields)).toBe(true);
    expect(Reflect.ownKeys(revision.snapshot)).toEqual([]);
    expect(Reflect.ownKeys(fields)).toEqual([]);
    expect(() => Object.assign(revision.snapshot, { debug: true })).toThrow();
    expect(() => Object.assign(fields, { debug: true })).toThrow();
    expect(() =>
      (revision.snapshot as unknown as Map<RenderEntityId, unknown>).set(
        world.mapEntity('forged'),
        fields
      )
    ).toThrow();
    expect(() =>
      (fields as unknown as Map<RenderFieldToken<unknown>, unknown>).set(Transform, [9, 9, 9])
    ).toThrow();
    expect(world.read(world.mapEntity('snapshot'), Transform)).toEqual([1, 2, 3]);
  });

  test('requires explicit removal and emits deterministic field diffs', () => {
    const world = createWorld([Transform]);
    const source = 1002 as never;
    publish(world, 1, (tx) =>
      tx.draft(extractor).upsert(tx.mapEntity(source), Transform, [0, 0, 0])
    );
    const next = publish(world, 2, (tx) => {
      const entity = tx.mapEntity(source);
      tx.draft(extractor).upsert(entity, Transform, [3, 0, 0]);
      tx.draft(extractor).upsert(entity, Visible, true);
    });
    expect(next.diff.changes.map((change) => change.kind)).toEqual([
      'field-added',
      'field-changed'
    ]);
    expect(() => world.read(txEntity(world, source), Visible)).not.toThrow();
  });

  test('rejects invalid transactions without publishing a partial revision', () => {
    const world = createWorld([Transform]);
    const source = 1003 as never;
    const tx = world.beginExtract(1, 0);
    tx.draft(extractor).upsert(tx.mapEntity(source), Visible, true);
    expect(() => tx.commit()).toThrow('required field');
    expect(world.revision).toBe(0);
  });

  test('removes an entity with a tombstone and allocates a new render generation', () => {
    const world = createWorld([Transform]);
    const source = 1004 as never;
    publish(world, 1, (tx) =>
      tx.draft(extractor).upsert(tx.mapEntity(source), Transform, [0, 0, 0])
    );
    const oldId = world.mapEntity(source);
    const removed = world.beginExtract(2, 1);
    removed.removeEntity(oldId, 'despawn');
    removed.commit();
    const recreated = publish(world, 3, (tx) =>
      tx.draft(extractor).upsert(tx.mapEntity(source), Transform, [1, 0, 0])
    );
    const newId = world.mapEntity(source);
    expect(newId).not.toBe(oldId);
    expect(recreated.diff.changes.map((change) => change.kind)).toEqual(['entity-added']);
  });

  test('projects immutable query snapshots from a revision', () => {
    const world = createWorld([Transform]);
    const source = 1005 as never;
    publish(world, 1, (tx) =>
      tx.draft(extractor).upsert(tx.mapEntity(source), Transform, [4, 0, 0])
    );
    const query = world.query({
      id: 'transforms',
      reads: [Transform],
      project: (view) => view.get(Transform)
    });
    const snapshot = query.run(world.snapshot());
    expect(snapshot.items).toEqual([[4, 0, 0]]);
    expect(Object.isFrozen(snapshot.items)).toBe(true);
  });

  test('queries only entities containing every declared read field', () => {
    const world = createWorld();
    const transformOnly = world.beginExtract(1, 0);
    transformOnly
      .draft(extractor)
      .upsert(transformOnly.mapEntity('transform-only'), Transform, [1, 0, 0]);
    transformOnly
      .draft(extractor)
      .upsert(transformOnly.mapEntity('complete'), Transform, [2, 0, 0]);
    transformOnly.draft(extractor).upsert(transformOnly.mapEntity('complete'), Visible, true);
    transformOnly.commit();

    const snapshot = world
      .query({
        id: 'visible-transforms',
        reads: [Transform, Visible],
        project: (view) => view.get(Transform)
      })
      .run(world.snapshot());

    expect(snapshot.items).toEqual([[2, 0, 0]]);
  });

  test('filters queries by required and excluded render tags', () => {
    const world = createWorld();
    const tx = world.beginExtract(1, 0);
    const selected = tx.mapEntity('selected');
    const hidden = tx.mapEntity('hidden');
    tx.draft(extractor).upsert(selected, Transform, [1, 0, 0]);
    tx.draft(extractor).upsert(selected, Selected, true);
    tx.draft(extractor).upsert(hidden, Transform, [2, 0, 0]);
    tx.draft(extractor).upsert(hidden, Selected, true);
    tx.draft(extractor).upsert(hidden, Hidden, true);
    tx.commit();

    const snapshot = world
      .query({
        id: 'selected-visible',
        reads: [Transform],
        with: [Selected],
        without: [Hidden],
        project: (view) => view.entity
      })
      .run(world.snapshot());

    expect(snapshot.items).toEqual([selected]);
  });

  test('structurally shares unchanged entity fields between revisions', () => {
    const world = createWorld();
    publish(world, 1, (tx) =>
      tx.draft(extractor).upsert(tx.mapEntity('stable'), Transform, [1, 0, 0])
    );
    const stable = world.mapEntity('stable');
    const before = world.snapshot().snapshot.get(stable);

    publish(world, 2, (tx) =>
      tx.draft(extractor).upsert(tx.mapEntity('changed'), Transform, [2, 0, 0])
    );

    expect(world.snapshot().snapshot.get(stable)).toBe(before);
  });

  test('does not compare unchanged fields while deriving an incremental diff', () => {
    const Opaque = defineRenderField<{ readonly value: number }>('opaque', {
      compare: () => {
        throw new Error('unchanged field was compared');
      }
    });
    const opaqueExtractor = defineExtractorToken('opaque', [Opaque]);
    const extractorPlan = new RenderExtractorRegistryBuilder()
      .registerExtractor(extractor)
      .registerExtractor(opaqueExtractor)
      .build();
    const world = new RenderWorld({ extractorPlan });
    publish(world, 1, (tx) =>
      tx.draft(opaqueExtractor).upsert(tx.mapEntity('opaque'), Opaque, { value: 1 })
    );

    expect(() =>
      publish(world, 2, (tx) =>
        tx.draft(extractor).upsert(tx.mapEntity('changed'), Transform, [2, 0, 0])
      )
    ).not.toThrow();
  });

  test('preserves a distinct tombstone reason for every removed entity', () => {
    const world = createWorld();
    publish(world, 1, (tx) => {
      tx.draft(extractor).upsert(tx.mapEntity('despawned'), Transform, [1, 0, 0]);
      tx.draft(extractor).upsert(tx.mapEntity('filtered'), Transform, [2, 0, 0]);
    });
    const tx = world.beginExtract(2, 1);
    tx.removeEntity(world.mapEntity('despawned'), 'despawn');
    tx.removeEntity(world.mapEntity('filtered'), 'extract-removed');

    const revision = tx.commit();
    const reasons = revision.diff.changes
      .filter((change) => change.kind === 'entity-removed')
      .map((change) => change.tombstone.reason);
    expect(reasons).toEqual(['despawn', 'extract-removed']);
  });

  test('reuses a released slot with an incremented generation', () => {
    const world = createWorld();
    const original = publish(world, 1, (tx) =>
      tx.draft(extractor).upsert(tx.mapEntity('old'), Transform, [1, 0, 0])
    );
    const oldId = world.mapEntity('old');
    original.release();
    const removal = world.beginExtract(2, 1);
    removal.removeEntity(oldId, 'despawn');
    removal.commit();

    const allocation = world.beginExtract(3, 2);
    const newId = allocation.mapEntity('new');
    allocation.draft(extractor).upsert(newId, Transform, [2, 0, 0]);
    allocation.commit().release();

    expect(Math.floor(newId / 0x100000)).toBe(Math.floor(oldId / 0x100000));
    expect(newId).not.toBe(oldId);
  });

  test('rejects writes through a stale render generation after slot reuse', () => {
    const world = createWorld();
    publish(world, 1, (tx) =>
      tx.draft(extractor).upsert(tx.mapEntity('old'), Transform, [1, 0, 0])
    );
    const stale = world.mapEntity('old');
    const removal = world.beginExtract(2, 1);
    removal.removeEntity(stale, 'despawn');
    removal.commit();
    const allocation = world.beginExtract(3, 2);
    const fresh = allocation.mapEntity('new');
    allocation.draft(extractor).upsert(fresh, Transform, [2, 0, 0]);
    allocation.commit().release();

    const tx = world.beginExtract(4, 3);
    expect(() => tx.draft(extractor).upsert(stale, Transform, [3, 0, 0])).toThrow(
      'stale render entity'
    );
  });

  test('arbitrates candidates in extractor-name order', () => {
    const A = defineExtractorToken('a', [Visible]);
    const B = defineExtractorToken('b', [Visible]);
    const observed: string[][] = [];
    const plan = new RenderExtractorRegistryBuilder()
      .registerExtractor(B)
      .registerExtractor(A)
      .registerArbitrator({
        field: Visible,
        contributors: [B, A],
        resolve(candidates) {
          observed.push(candidates.map((candidate) => candidate.extractor.name));
          return { kind: 'publish', value: true };
        }
      })
      .build();
    const world = new RenderWorld({ extractorPlan: plan });
    const tx = world.beginExtract(1, 0);
    const entity = tx.mapEntity('candidate');
    tx.draft(B).upsert(entity, Visible, false);
    tx.draft(A).upsert(entity, Visible, true);
    tx.commit().release();
    expect(observed).toEqual([['a', 'b']]);
    expect(world.read(entity, Visible)).toBe(true);
  });

  test('rejects duplicate owners without a complete arbitrator', () => {
    const A = defineExtractorToken('a', [Visible]);
    const B = defineExtractorToken('b', [Visible]);
    expect(() =>
      new RenderExtractorRegistryBuilder().registerExtractor(A).registerExtractor(B).build()
    ).toThrow('no arbitrator');
    expect(() =>
      new RenderExtractorRegistryBuilder()
        .registerExtractor(A)
        .registerExtractor(B)
        .registerArbitrator({
          field: Visible,
          contributors: [A],
          resolve: () => ({ kind: 'unchanged' })
        })
        .build()
    ).toThrow('every contributor');
  });

  test('rolls back mappings and burns an exposed generation when validation fails', () => {
    const world = createWorld([Transform]);
    const failed = world.beginExtract(1, 0);
    const stale = failed.mapEntity('failed');
    failed.draft(extractor).upsert(stale, Visible, true);
    expect(() => failed.commit()).toThrow('required field');
    expect(world.revision).toBe(0);
    expect(() => world.mapEntity('failed')).toThrow('inside an extract transaction');

    const retry = world.beginExtract(2, 0);
    const current = retry.mapEntity('failed');
    expect(current).not.toBe(stale);
    retry.draft(extractor).upsert(current, Transform, [1, 0, 0]);
    retry.commit().release();
    const next = world.beginExtract(3, 2);
    expect(() => next.draft(extractor).upsert(stale, Transform, [2, 0, 0])).toThrow('stale');
  });

  test('holds retired slots until older revision leases are released', () => {
    const world = createWorld();
    const held = publish(world, 1, (tx) =>
      tx.draft(extractor).upsert(tx.mapEntity('old'), Transform, [1, 0, 0])
    );
    const old = world.mapEntity('old');
    const removal = world.beginExtract(2, 1);
    removal.removeEntity(old, 'despawn');
    removal.commit().release();
    const whileHeld = world.beginExtract(3, 2);
    const differentSlot = whileHeld.mapEntity('held');
    expect(Math.floor(differentSlot / 0x100000)).not.toBe(Math.floor(old / 0x100000));
    whileHeld.draft(extractor).upsert(differentSlot, Transform, [2, 0, 0]);
    whileHeld.commit().release();
    held.release();

    const afterRelease = world.beginExtract(4, 3);
    const reused = afterRelease.mapEntity('reused');
    expect(Math.floor(reused / 0x100000)).toBe(Math.floor(old / 0x100000));
  });
});

function txEntity(world: RenderWorld, source: unknown): RenderEntityId {
  return world.mapEntity(source as never);
}
