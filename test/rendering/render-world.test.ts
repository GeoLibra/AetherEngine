import { describe, expect, test } from 'vitest';
import {
  RenderWorld,
  defineExtractorToken,
  defineRenderField,
  type RenderEntityId
} from '../../src/rendering';

const Transform = defineRenderField<[number, number, number]>('transform');
const Visible = defineRenderField<boolean>('visible');
const extractor = defineExtractorToken('scene', [Transform, Visible]);

function publish(world: RenderWorld, tick: number, write: (draft: ReturnType<RenderWorld['beginExtract']>) => void) {
  const transaction = world.beginExtract(tick, tick - 1);
  write(transaction);
  return transaction.commit();
}

describe('RenderWorld', () => {
  test('publishes generation-safe mapped entities and coalesced fields', () => {
    const world = new RenderWorld({ requiredFields: [Transform] });
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

  test('requires explicit removal and emits deterministic field diffs', () => {
    const world = new RenderWorld({ requiredFields: [Transform] });
    const source = 1002 as never;
    publish(world, 1, (tx) => tx.draft(extractor).upsert(tx.mapEntity(source), Transform, [0, 0, 0]));
    const next = publish(world, 2, (tx) => {
      const entity = tx.mapEntity(source);
      tx.draft(extractor).upsert(entity, Transform, [3, 0, 0]);
      tx.draft(extractor).upsert(entity, Visible, true);
    });
    expect(next.diff.changes.map((change) => change.kind)).toEqual(['field-added', 'field-changed']);
    expect(() => world.read(txEntity(world, source), Visible)).not.toThrow();
  });

  test('rejects invalid transactions without publishing a partial revision', () => {
    const world = new RenderWorld({ requiredFields: [Transform] });
    const source = 1003 as never;
    const tx = world.beginExtract(1, 0);
    tx.draft(extractor).upsert(tx.mapEntity(source), Visible, true);
    expect(() => tx.commit()).toThrow('required field');
    expect(world.revision).toBe(0);
  });

  test('removes an entity with a tombstone and allocates a new render generation', () => {
    const world = new RenderWorld({ requiredFields: [Transform] });
    const source = 1004 as never;
    publish(world, 1, (tx) => tx.draft(extractor).upsert(tx.mapEntity(source), Transform, [0, 0, 0]));
    const oldId = world.mapEntity(source);
    const removed = world.beginExtract(2, 1);
    removed.removeEntity(oldId, 'despawn');
    removed.commit();
    const recreated = publish(world, 3, (tx) => tx.draft(extractor).upsert(tx.mapEntity(source), Transform, [1, 0, 0]));
    const newId = world.mapEntity(source);
    expect(newId).not.toBe(oldId);
    expect(recreated.diff.changes.map((change) => change.kind)).toEqual(['entity-added']);
  });

  test('projects immutable query snapshots from a revision', () => {
    const world = new RenderWorld({ requiredFields: [Transform] });
    const source = 1005 as never;
    publish(world, 1, (tx) => tx.draft(extractor).upsert(tx.mapEntity(source), Transform, [4, 0, 0]));
    const query = world.query({ id: 'transforms', reads: [Transform], project: (view) => view.get(Transform) });
    const snapshot = query.run(world.snapshot());
    expect(snapshot.items).toEqual([[4, 0, 0]]);
    expect(Object.isFrozen(snapshot.items)).toBe(true);
  });
});

function txEntity(world: RenderWorld, source: unknown): RenderEntityId {
  return world.mapEntity(source as never);
}
