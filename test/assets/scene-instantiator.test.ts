import { describe, expect, test } from 'vitest';
import type { AssetId } from '../../src/assets/types';
import type { CanonicalSceneDocument } from '../../src/assets/canonical/types';
import {
  cookCanonicalScene,
  instantiateCookedScene
} from '../../src/assets/cooker/scene-instantiator';
import { cookCanonicalMeshDocument } from '../../src/assets/cooker/mesh-cooker';
import type { CookedMeshArtifact } from '../../src/assets/cooker/types';
import { World } from '../../src/ecs/world';
import { LocalTransform, WorldTransform } from '../../src/transform';
import { MeshRenderSource } from '../../src/rendering/mesh/mesh-render-source';

describe('scene instantiator', () => {
  test('cooks canonical scene hierarchy and computes world transform matrices', () => {
    const sceneDoc: CanonicalSceneDocument = {
      id: 'scene.1' as AssetId,
      kind: 'scene',
      version: 1,
      nodes: [
        {
          name: 'parent',
          transform: {
            kind: 'trs',
            translation: [10, 0, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1]
          },
          children: [1]
        },
        {
          name: 'child',
          transform: {
            kind: 'trs',
            translation: [0, 5, 0],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1]
          },
          meshId: 'mesh.1' as AssetId,
          children: []
        }
      ],
      rootNodes: [0],
      defaultSceneIndex: 0
    };

    const cookedScene = cookCanonicalScene(sceneDoc);
    expect(cookedScene.nodes).toHaveLength(2);

    // Parent translation is [10, 0, 0]
    expect(cookedScene.nodes[0]!.worldTransform[12]).toBe(10);
    expect(cookedScene.nodes[0]!.worldTransform[13]).toBe(0);

    // Child world translation is [10, 5, 0]
    expect(cookedScene.nodes[1]!.worldTransform[12]).toBe(10);
    expect(cookedScene.nodes[1]!.worldTransform[13]).toBe(5);
  });

  test('instantiates cooked scene into ECS World with WorldTransform and MeshRenderSource', () => {
    const sceneDoc: CanonicalSceneDocument = {
      id: 'scene.2' as AssetId,
      kind: 'scene',
      version: 1,
      nodes: [
        {
          name: 'meshNode',
          transform: {
            kind: 'trs',
            translation: [2, 3, 4],
            rotation: [0, 0, 0, 1],
            scale: [1, 1, 1]
          },
          meshId: 'mesh.2' as AssetId,
          children: []
        }
      ],
      rootNodes: [0],
      defaultSceneIndex: 0
    };

    const meshDoc = {
      id: 'mesh.2' as AssetId,
      kind: 'mesh' as const,
      version: 1,
      primitives: [
        {
          topology: 'triangle-list' as const,
          attributes: [
            {
              semantic: 'position' as const,
              format: 'float32x3' as const,
              count: 3,
              normalized: false,
              data: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])
            }
          ],
          indices: null,
          materialId: 'mat.1' as AssetId,
          bounds: { min: [0, 0, 0] as const, max: [1, 1, 0] as const }
        }
      ]
    };

    const cookedMesh = cookCanonicalMeshDocument(meshDoc);
    const cookedScene = cookCanonicalScene(sceneDoc);

    const meshMap = new Map<string, CookedMeshArtifact>([['mesh.2', cookedMesh]]);

    const world = new World();
    world.registerComponent(LocalTransform);
    world.registerComponent(WorldTransform);
    world.registerComponent(MeshRenderSource);

    const entities = instantiateCookedScene(cookedScene, meshMap, world);
    expect(entities).toHaveLength(1);

    const entity = entities[0]!;
    expect(world.hasComponent(entity, LocalTransform)).toBe(true);
    expect(world.hasComponent(entity, WorldTransform)).toBe(true);
    expect(world.hasComponent(entity, MeshRenderSource)).toBe(true);

    const localTransform = world.getComponent(entity, LocalTransform) as any;
    expect(Array.from(localTransform.translation)).toEqual([2, 3, 4]);

    const worldTransform = world.getComponent(entity, WorldTransform) as any;
    expect(worldTransform.matrix[12]).toBe(2);
    expect(worldTransform.matrix[13]).toBe(3);
    expect(worldTransform.matrix[14]).toBe(4);

    const renderSource = world.getComponent(entity, MeshRenderSource) as any;
    expect(renderSource.mesh.handle.assetId).toBe('mesh.2');
    expect(renderSource.materials[0].handle.assetId).toBe('mat.1');
  });
});
