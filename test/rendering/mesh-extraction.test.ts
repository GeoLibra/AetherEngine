import { describe, expect, test } from 'vitest';
import {
  MaterialAssetType,
  MeshAssetField,
  MeshAssetType,
  MeshLocalBoundsField,
  MeshMaterialsField,
  MeshRenderExtraction,
  MeshRenderSource,
  MeshTransformField,
  MeshVisibilityField,
  MeshWorldBoundsField,
  RenderWorld,
  World,
  WorldTransform,
  createAssetHandle,
  createMeshRenderExtractorPlan,
  type Entity,
  type MeshRenderSourceView,
  type RenderTransformFact
} from '../../src';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;

function source(visible = true): MeshRenderSourceView {
  return {
    mesh: { handle: createAssetHandle(MeshAssetType, 'mesh:cube'), payloadVersion: 2 },
    submesh: 0,
    materials: [
      {
        slot: 0,
        handle: createAssetHandle(MaterialAssetType, 'material:default'),
        payloadVersion: 3
      }
    ],
    localBounds: {
      aabb: { min: [-1, -1, -1], max: [1, 1, 1] },
      sphere: { center: [0, 0, 0], radius: Math.sqrt(3) }
    },
    visible,
    layerMask: 3
  };
}

function transform(entity: Entity, translation = 0): RenderTransformFact {
  const matrix: number[] = [...identity];
  matrix[12] = translation;
  return {
    matrix,
    previousMatrix: matrix,
    normalMatrix: identity.slice(0, 9),
    determinantSign: 1,
    worldVersion: 1
  };
}

function createFixture() {
  const main = new World();
  main.registerComponent(WorldTransform).registerComponent(MeshRenderSource);
  const render = new RenderWorld({
    requiredFields: [
      MeshTransformField,
      MeshLocalBoundsField,
      MeshWorldBoundsField,
      MeshAssetField,
      MeshMaterialsField,
      MeshVisibilityField
    ],
    extractorPlan: createMeshRenderExtractorPlan()
  });
  return { main, render, extraction: new MeshRenderExtraction(main, render) };
}

function spawn(main: World, value = source()): Entity {
  return main
    .spawn()
    .insert(WorldTransform, {
      matrix: identity,
      previousMatrix: identity,
      normalMatrix: identity.slice(0, 9),
      worldVersion: 1,
      originCell: [0, 0, 0],
      determinantSign: 1
    })
    .insert(MeshRenderSource, { ...value })
    .build();
}

describe('mesh RenderWorld extraction', () => {
  test('publishes the complete immutable mesh fact set and conservative world bounds', () => {
    const { main, render, extraction } = createFixture();
    const entity = spawn(main);
    const revision = extraction.extract({
      sourceTick: 1,
      transforms: new Map([[entity, transform(entity, 5)]])
    });
    const renderEntity = render.mapEntity(entity);

    expect(revision.diff.changes.map((change) => change.kind)).toEqual(['entity-added']);
    expect(render.read(renderEntity, MeshAssetField)).toEqual({
      handle: { assetId: 'mesh:cube', type: 'asset.geometry-mesh' },
      payloadVersion: 2,
      submesh: 0
    });
    expect(render.read(renderEntity, MeshWorldBoundsField)).toMatchObject({
      aabb: { min: [4, -1, -1], max: [6, 1, 1] },
      sphere: { center: [5, 0, 0] }
    });
    const materials = render.read(renderEntity, MeshMaterialsField)!;
    expect(
      () =>
        ((materials as unknown as { handle: { assetId: string } }[])[0]!.handle.assetId =
          'caller-mutation')
    ).toThrow();
    expect(render.read(renderEntity, MeshMaterialsField)![0]!.handle.assetId).toBe(
      'material:default'
    );
    revision.release();
  });

  test('publishes only changed facts on normal incremental frames', () => {
    const { main, render, extraction } = createFixture();
    const entity = spawn(main);
    extraction
      .extract({ sourceTick: 1, transforms: new Map([[entity, transform(entity)]]) })
      .release();
    const unchanged = extraction.extract({
      sourceTick: 2,
      transforms: new Map([[entity, transform(entity)]])
    });
    expect(unchanged.diff.changes).toEqual([]);
    unchanged.release();

    main.insertComponent(entity, MeshRenderSource, { ...source(false) });
    const changed = extraction.extract({
      sourceTick: 3,
      transforms: new Map([[entity, transform(entity)]])
    });
    expect(changed.diff.changes).toEqual([
      expect.objectContaining({ kind: 'field-changed', field: MeshVisibilityField })
    ]);
    expect(render.read(render.mapEntity(entity), MeshVisibilityField)?.visible).toBe(false);
    changed.release();
  });

  test('uses explicit component-removal and despawn tombstones', () => {
    const { main, render, extraction } = createFixture();
    const removedComponent = spawn(main);
    const despawned = spawn(main);
    extraction
      .extract({
        sourceTick: 1,
        transforms: new Map([
          [removedComponent, transform(removedComponent)],
          [despawned, transform(despawned)]
        ])
      })
      .release();
    main.removeComponent(removedComponent, MeshRenderSource);
    main.despawn(despawned);

    const revision = extraction.extract({ sourceTick: 2, transforms: new Map() });
    const removals = revision.diff.changes.filter((change) => change.kind === 'entity-removed');
    expect(removals.map((change) => change.tombstone.reason).sort()).toEqual([
      'despawn',
      'extract-removed'
    ]);
    expect(render.revision).toBe(2);
    revision.release();
  });

  test('allocates a new RenderEntity generation when an ECS slot generation is replaced', () => {
    const { main, render, extraction } = createFixture();
    const first = spawn(main);
    extraction
      .extract({ sourceTick: 1, transforms: new Map([[first, transform(first)]]) })
      .release();
    const oldRenderEntity = render.mapEntity(first);
    main.despawn(first);
    const second = spawn(main);

    const revision = extraction.extract({
      sourceTick: 2,
      transforms: new Map([[second, transform(second)]])
    });
    expect(second).not.toBe(first);
    expect(render.mapEntity(second)).not.toBe(oldRenderEntity);
    expect(revision.diff.changes.map((change) => change.kind).sort()).toEqual([
      'entity-added',
      'entity-removed'
    ]);
    revision.release();
  });

  test('ends and replaces a render lifecycle when eligibility is removed and restored between extracts', () => {
    const { main, render, extraction } = createFixture();
    const entity = spawn(main);
    extraction
      .extract({ sourceTick: 1, transforms: new Map([[entity, transform(entity)]]) })
      .release();
    const previous = render.mapEntity(entity);
    main.removeComponent(entity, MeshRenderSource);
    main.insertComponent(entity, MeshRenderSource, { ...source(false) });

    const revision = extraction.extract({
      sourceTick: 2,
      transforms: new Map([[entity, transform(entity)]])
    });
    expect(render.mapEntity(entity)).not.toBe(previous);
    expect(revision.diff.changes.map((change) => change.kind).sort()).toEqual([
      'entity-added',
      'entity-removed'
    ]);
    expect(
      revision.diff.changes.find((change) => change.kind === 'entity-removed')?.tombstone.reason
    ).toBe('extract-removed');
    revision.release();
  });

  test('keeps the last-known-good revision and fully resyncs after extraction failure', () => {
    const { main, render, extraction } = createFixture();
    const first = spawn(main);
    extraction
      .extract({ sourceTick: 1, transforms: new Map([[first, transform(first)]]) })
      .release();
    const second = spawn(main);

    expect(() => extraction.extract({ sourceTick: 2, transforms: new Map() })).toThrow(
      /missing transform snapshot/i
    );
    expect(render.revision).toBe(1);

    const recovered = extraction.extract({
      sourceTick: 3,
      transforms: new Map([
        [first, transform(first)],
        [second, transform(second)]
      ])
    });
    expect(render.mapEntity(second)).toBeDefined();
    expect(recovered.diff.changes.map((change) => change.kind)).toEqual(['entity-added']);
    recovered.release();
  });

  test('rejects a source tick that moves backwards without opening a revision', () => {
    const { main, render, extraction } = createFixture();
    const entity = spawn(main);
    extraction
      .extract({ sourceTick: 2, transforms: new Map([[entity, transform(entity)]]) })
      .release();

    expect(() =>
      extraction.extract({ sourceTick: 1, transforms: new Map([[entity, transform(entity)]]) })
    ).toThrow(/must not move backwards/i);
    expect(render.revision).toBe(1);
  });

  test('releases its change reader once and rejects extraction after disposal', () => {
    const { extraction } = createFixture();
    extraction.dispose();
    extraction.dispose();
    expect(() => extraction.extract({ sourceTick: 1, transforms: new Map() })).toThrow(
      /disposed mesh extraction/i
    );
  });
});
