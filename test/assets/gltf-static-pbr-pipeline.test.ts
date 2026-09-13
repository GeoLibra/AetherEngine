import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GltfImporter } from '../../src/assets/importers/gltf';
import { InMemoryDiagnosticSink, StandardImportBudget } from '../../src/assets/importer';
import { VirtualFileSystem } from '../../src/assets/vfs';
import { createSyntheticGlbFixture } from '../../benchmark/asset-pipeline/gltf-ingestion';
import {
  cookCanonicalMeshDocument,
  cookCanonicalMaterial,
  cookCanonicalScene,
  cookCanonicalTexture,
  canonicalMaterialToStandardLitOptions,
  CookedTextureRegistry,
  instantiateCookedScene
} from '../../src/assets/cooker';
import type { CookedMeshArtifact, CookedSceneArtifact } from '../../src/assets/cooker/types';
import { prepareMesh } from '../../src/rendering/mesh/mesh-prepare';
import { prepareStandardLitTextureBindings } from '../../src/rendering/material/standard-lit-textures';
import { World } from '../../src/ecs/world';
import { LocalTransform, WorldTransform } from '../../src/transform';
import { MeshRenderSource } from '../../src/rendering/mesh/mesh-render-source';
import type {
  RHIBuffer,
  RHIDevice,
  RHISampler,
  RHITexture,
  RHITextureView
} from '../../src/rhi/contracts';
import type {
  CanonicalStandardPbrMaterial,
  CanonicalTextureDocument
} from '../../src/assets/canonical/types';
import type { AssetId } from '../../src/assets/types';

describe('glTF static PBR end-to-end pipeline', () => {
  test('ingests GLB atomically without hand-crafted assets, cooks, prepares GPU resources and instantiates into ECS', async () => {
    // 1. Synthetic GLB Ingestion
    const glbBytes = createSyntheticGlbFixture(100);
    const vfs = new VirtualFileSystem();
    const importer = new GltfImporter();

    const context = {
      vfs,
      signal: new AbortController().signal,
      budget: new StandardImportBudget({ maxSizeBytes: 10 * 1024 * 1024 }),
      diagnostics: new InMemoryDiagnosticSink(),
      dependencies: {
        resolve: (_p: string, r: string) => r,
        load: async () => new Uint8Array(0)
      }
    };

    const importResult = await importer.import(
      {
        uri: 'virtual://models/test.glb',
        kind: 'buffer',
        buffer: glbBytes
      },
      context
    );

    expect(importResult.kind).toBe('success');
    if (importResult.kind !== 'success') return;

    // Atomically published bundle contains all canonical assets
    const bundle = importResult.bundle!;
    expect(bundle).toBeDefined();
    expect(bundle.meshes.length).toBeGreaterThan(0);
    expect(bundle.materials.length).toBeGreaterThan(0);

    const canonicalMesh = bundle.meshes[0]!;
    const canonicalMaterial = bundle.materials[0]!;
    const canonicalScene = bundle.scene;

    // 2. Cooking Phase directly on imported canonical assets
    const cookedMesh = cookCanonicalMeshDocument(canonicalMesh, { materials: bundle.materials });
    expect(cookedMesh.primitives[0]!.hasGeneratedTangents).toBe(true);
    expect(cookedMesh.primitives[0]!.meshData.indices?.format).toBe('u16'); // Downsampled to u16

    const cookedMaterial = cookCanonicalMaterial(canonicalMaterial, { samplers: bundle.samplers });
    expect(cookedMaterial.instance).toBeDefined();

    const cookedScene = cookCanonicalScene(canonicalScene);
    expect(cookedScene.nodes.length).toBeGreaterThan(0);

    // 3. Mock RHI Device
    const mockBuffer: RHIBuffer = {
      label: 'mock-buffer',
      size: 1024,
      usage: 0,
      state: 'live',
      generation: 1,
      dispose: vi.fn()
    } as unknown as RHIBuffer;
    const mockView: RHITextureView = {
      label: 'mock-view',
      state: 'live',
      generation: 1,
      dispose: vi.fn()
    } as unknown as RHITextureView;
    const mockTexture: RHITexture = {
      label: 'mock-texture',
      format: 'rgba8unorm',
      usage: 0,
      state: 'live',
      generation: 1,
      createView: vi.fn().mockReturnValue(mockView),
      dispose: vi.fn()
    } as unknown as RHITexture;
    const mockSampler: RHISampler = {
      label: 'mock-sampler',
      state: 'live',
      generation: 1,
      dispose: vi.fn()
    } as unknown as RHISampler;

    const mockDevice: RHIDevice = {
      state: 'live',
      generation: 1,
      createBuffer: vi.fn().mockReturnValue(mockBuffer),
      createTexture: vi.fn().mockReturnValue(mockTexture),
      createSampler: vi.fn().mockReturnValue(mockSampler),
      queue: {
        writeBuffer: vi.fn(),
        writeTexture: vi.fn(),
        submit: vi.fn()
      }
    } as unknown as RHIDevice;

    // 4. GPU Mesh Preparation
    const preparedMesh = prepareMesh(mockDevice, cookedMesh.primitives[0]!.meshData, {
      assetId: canonicalMesh.id,
      payloadVersion: 1,
      featurePolicyKey: 'default',
      abiVersion: 'standard-abi.v2'
    });
    expect(preparedMesh.value.vertexBuffers.length).toBe(5);
    expect(preparedMesh.value.indexBuffer).toBeDefined();

    // 5. Decoded Texture Cooking & Binding
    const decodedTextureDoc: CanonicalTextureDocument = {
      id: 'tex.test-diffuse' as AssetId,
      kind: 'texture',
      version: 1,
      width: 2,
      height: 2,
      data: new Uint8Array(16).fill(200)
    };
    const cookedTexture = cookCanonicalTexture(decodedTextureDoc, 'base-color');
    const textureRegistry = new CookedTextureRegistry();
    textureRegistry.registerTexture(cookedTexture);
    textureRegistry.prepare(mockDevice);

    const textureBindings = prepareStandardLitTextureBindings({
      device: mockDevice,
      textureIds: [
        decodedTextureDoc.id,
        'aether.texture.white-data',
        'aether.texture.flat-normal',
        'aether.texture.white-data',
        'aether.texture.black-srgb'
      ],
      samplerId: 'aether.sampler.linear-repeat',
      resolver: textureRegistry
    });
    expect(textureBindings.views).toHaveLength(5);

    // 6. Scene Instantiation into ECS World
    const world = new World();
    world.registerComponent(LocalTransform);
    world.registerComponent(WorldTransform);
    world.registerComponent(MeshRenderSource);

    const meshMap = new Map<string, CookedMeshArtifact>([[canonicalMesh.id, cookedMesh]]);
    const entities = instantiateCookedScene(cookedScene, meshMap, world);
    expect(entities.length).toBeGreaterThan(0);

    for (const entity of entities) {
      expect(world.hasComponent(entity, WorldTransform)).toBe(true);
      expect(world.hasComponent(entity, MeshRenderSource)).toBe(true);
      const source = world.getComponent(entity, MeshRenderSource)!;
      expect(source.mesh.handle.assetId).toBe(canonicalMesh.id);
    }

    textureBindings.dispose();
    textureRegistry.dispose();
  });

  test('pipeline handles real-world DamagedHelmet.glb end-to-end', async () => {
    const helmetPath = resolve(
      process.cwd(),
      'examples/react-vite-ts/public/assets/models/DamagedHelmet.glb'
    );
    const glbBytes = new Uint8Array(readFileSync(helmetPath));

    const importer = new GltfImporter();
    const context = {
      vfs: new VirtualFileSystem(),
      signal: new AbortController().signal,
      budget: new StandardImportBudget({ maxSizeBytes: 50 * 1024 * 1024 }),
      diagnostics: new InMemoryDiagnosticSink(),
      dependencies: { resolve: (_p: string, r: string) => r, load: async () => new Uint8Array(0) }
    };

    const importResult = await importer.import(
      { uri: 'file:///models/DamagedHelmet.glb', kind: 'buffer', buffer: glbBytes },
      context
    );

    expect(importResult.kind).toBe('success');
    if (importResult.kind !== 'success') return;

    const bundle = importResult.bundle!;
    expect(bundle.meshes).toHaveLength(1);
    expect(bundle.materials).toHaveLength(1);
    expect(bundle.textures.length).toBe(5);

    const mesh = bundle.meshes[0]!;
    expect(mesh.primitives[0]!.attributes[0]!.count).toBe(14556);

    const cookedMesh = cookCanonicalMeshDocument(mesh, { materials: bundle.materials });
    expect(cookedMesh.primitives[0]!.hasGeneratedTangents).toBe(true);
    expect(cookedMesh.primitives[0]!.meshData.indices?.format).toBe('u16');

    const cookedScene = cookCanonicalScene(bundle.scene);
    const world = new World();
    world.registerComponent(LocalTransform);
    world.registerComponent(WorldTransform);
    world.registerComponent(MeshRenderSource);

    const meshMap = new Map<string, CookedMeshArtifact>([[mesh.id, cookedMesh]]);
    const entities = instantiateCookedScene(cookedScene, meshMap, world);
    expect(entities.length).toBe(1);
  });

  test('guarantees memory ownership isolation against caller buffer mutations', async () => {
    const glbBytes = createSyntheticGlbFixture(50);
    const importer = new GltfImporter();
    const context = {
      vfs: new VirtualFileSystem(),
      signal: new AbortController().signal,
      budget: new StandardImportBudget({ maxSizeBytes: 10 * 1024 * 1024 }),
      diagnostics: new InMemoryDiagnosticSink(),
      dependencies: { resolve: (_p: string, r: string) => r, load: async () => new Uint8Array(0) }
    };

    const importResult = await importer.import(
      { uri: 'virtual://models/test-isolation.glb', kind: 'buffer', buffer: glbBytes },
      context
    );
    expect(importResult.kind).toBe('success');
    if (importResult.kind !== 'success') return;

    const mesh = importResult.bundle!.meshes[0]!;
    const posAttr = mesh.primitives[0]!.attributes.find((a) => a.semantic === 'position')!;
    const originalFirstPos = (posAttr.data as Float32Array)[0]!;

    // Aggressively mutate caller's original buffer
    glbBytes.fill(0xee);

    // Canonical data must remain completely unaffected
    const afterMutationFirstPos = (posAttr.data as Float32Array)[0]!;
    expect(afterMutationFirstPos).toBe(originalFirstPos);
  });

  test('scene reachability pruning excludes unreferenced detached nodes', () => {
    // Cooked scene with rootNodes = [0]. Node 1 is child of 0. Node 2 is detached.
    const scene: CookedSceneArtifact = {
      id: 'scene.reachability-test' as AssetId,
      kind: 'scene',
      version: 1,
      defaultSceneIndex: 0,
      rootNodes: [0],
      nodes: [
        {
          nodeIndex: 0,
          name: 'Root',
          localTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          worldTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          children: [1]
        },
        {
          nodeIndex: 1,
          name: 'ReachableChild',
          localTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          worldTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          meshId: 'mesh.child' as AssetId,
          children: []
        },
        {
          nodeIndex: 2,
          name: 'DetachedUnreachableNode',
          localTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          worldTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          meshId: 'mesh.detached' as AssetId,
          children: []
        }
      ]
    };

    const dummyMesh: CookedMeshArtifact = {
      id: 'mesh.dummy' as AssetId,
      kind: 'mesh',
      version: 1,
      totalByteLength: 0,
      primitives: [
        {
          primitiveIndex: 0,
          materialId: null,
          originalIndexFormat: 'none',
          cookedIndexFormat: 'none',
          meshData: {
            topology: 'triangles',
            frontFace: 'ccw',
            vertexCount: 3,
            streams: [],
            submeshes: [{ start: 0, count: 3, materialSlot: 0 }],
            bounds: {
              aabb: { min: [0, 0, 0], max: [1, 1, 1] },
              sphere: { center: [0, 0, 0], radius: 1 }
            }
          },
          hasGeneratedTangents: false
        }
      ]
    };

    const meshMap = new Map<string, CookedMeshArtifact>([
      ['mesh.child', dummyMesh],
      ['mesh.detached', dummyMesh]
    ]);

    const world = new World();
    world.registerComponent(LocalTransform);
    world.registerComponent(WorldTransform);
    world.registerComponent(MeshRenderSource);

    const entities = instantiateCookedScene(scene, meshMap, world);
    // Only node 1 should be instantiated (reachable). Node 2 should be skipped.
    expect(entities).toHaveLength(1);
  });

  test('material cooker preserves per-slot samplers without rejecting heterogeneous samplers', () => {
    const heterogeneousMaterial: CanonicalStandardPbrMaterial = {
      id: 'mat.hetero' as AssetId,
      kind: 'material',
      version: 1,
      baseColorFactor: [1, 1, 1, 1],
      baseColorTexture: {
        textureId: 'tex.base' as AssetId,
        samplerId: 'samp.repeat' as AssetId,
        texCoord: 0,
        transform: { offset: [0, 0], scale: [1, 1], rotation: 0 }
      },
      metallicFactor: 1,
      roughnessFactor: 1,
      metallicRoughnessTexture: null,
      normalTexture: {
        textureId: 'tex.normal' as AssetId,
        samplerId: 'samp.clamp' as AssetId,
        texCoord: 0,
        scale: 1,
        transform: { offset: [0, 0], scale: [1, 1], rotation: 0 }
      },
      occlusionTexture: null,
      emissiveFactor: [0, 0, 0],
      emissiveTexture: null,
      alphaMode: 'opaque',
      alphaCutoff: 0.5,
      doubleSided: false
    };

    const options = canonicalMaterialToStandardLitOptions(heterogeneousMaterial);
    expect(options.samplers?.baseColor?.assetId).toBe('samp.repeat');
    expect(options.samplers?.normal?.assetId).toBe('samp.clamp');
    expect(options.sampler?.assetId).toBe('samp.repeat');
  });
});
