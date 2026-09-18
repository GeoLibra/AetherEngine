import { describe, expect, test } from 'vitest';
import { GltfImporter } from '../../src/assets/importers/gltf';
import { InMemoryDiagnosticSink, StandardImportBudget } from '../../src/assets/importer';
import { VirtualFileSystem } from '../../src/assets/vfs';
import { createSyntheticGlbFixture } from '../../benchmark/asset-pipeline/gltf-ingestion';
import { cookCanonicalMeshDocument, cookCanonicalMaterial } from '../../src/assets/cooker';
import {
  BaselineRenderer,
  buildPreparedDrawPhase,
  createAssetHandle,
  MaterialAssetType,
  MeshAssetType,
  NullDevice,
  NullSurface,
  type BrowserGraphicsSession,
  type RenderEntityId
} from '../../src';
import { BaselineStandardLitPreparation } from '../../src/rendering/baseline/baseline-preparation';

describe('glTF multi-backend static PBR rendering', () => {
  test('executes multi-backend static PBR pipeline across WebGPU and WebGL2 sessions with transparent sorting', async () => {
    // 1. Ingest synthetic GLB
    const glbBytes = createSyntheticGlbFixture(50);
    const vfs = new VirtualFileSystem();
    const importer = new GltfImporter();
    const context = {
      vfs,
      signal: new AbortController().signal,
      budget: new StandardImportBudget({ maxSizeBytes: 10 * 1024 * 1024 }),
      diagnostics: new InMemoryDiagnosticSink(),
      dependencies: {
        resolve: (p: string, r: string) => r,
        load: async () => new Uint8Array(0)
      }
    };
    const importResult = await importer.import(
      { uri: 'virtual://models/test.glb', kind: 'buffer', buffer: glbBytes },
      context
    );
    expect(importResult.kind).toBe('success');
    if (importResult.kind !== 'success') return;

    // 2. Cook canonical mesh and materials (one opaque, one transparent blend)
    const canonicalMesh = {
      id: 'mesh.test' as any,
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
            },
            {
              semantic: 'normal' as const,
              format: 'float32x3' as const,
              count: 3,
              normalized: false,
              data: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1])
            },
            {
              semantic: 'texcoord-0' as const,
              format: 'float32x2' as const,
              count: 3,
              normalized: false,
              data: new Float32Array([0, 0, 1, 0, 0, 1])
            }
          ],
          indices: {
            format: 'u16' as const,
            count: 3,
            data: new Uint16Array([0, 1, 2])
          },
          materialId: 'mat.opaque' as any,
          bounds: { min: [0, 0, 0] as const, max: [1, 1, 0] as const }
        }
      ]
    };
    const cookedMesh = cookCanonicalMeshDocument(canonicalMesh);

    const opaqueMaterial = cookCanonicalMaterial({
      id: 'mat.opaque' as any,
      kind: 'material' as const,
      version: 1,
      baseColorFactor: [0.8, 0.8, 0.8, 1.0],
      baseColorTexture: null,
      metallicFactor: 0.5,
      roughnessFactor: 0.5,
      metallicRoughnessTexture: null,
      normalTexture: null,
      occlusionTexture: null,
      emissiveFactor: [0, 0, 0],
      emissiveTexture: null,
      alphaMode: 'opaque',
      alphaCutoff: 0.5,
      doubleSided: false
    });

    const transparentMaterial = cookCanonicalMaterial({
      id: 'mat.transparent' as any,
      kind: 'material' as const,
      version: 1,
      baseColorFactor: [1.0, 1.0, 1.0, 0.5],
      baseColorTexture: null,
      metallicFactor: 0.0,
      roughnessFactor: 0.1,
      metallicRoughnessTexture: null,
      normalTexture: null,
      occlusionTexture: null,
      emissiveFactor: [0, 0, 0],
      emissiveTexture: null,
      alphaMode: 'blend',
      alphaCutoff: 0.5,
      doubleSided: true
    });

    expect(opaqueMaterial.asset.renderState.surface).toBe('opaque');
    expect(transparentMaterial.asset.renderState.surface).toBe('transparent');
    expect(transparentMaterial.asset.renderState.depthWrite).toBe(false);

    // 3. Multi-backend testing: WebGPU and WebGL2
    const backends = ['webgpu', 'webgl2'] as const;
    for (const backend of backends) {
      const baseDevice = new NullDevice();
      const device =
        backend === 'webgpu'
          ? new NullDevice({
              capabilities: {
                ...baseDevice.capabilities,
                limits: {
                  ...baseDevice.capabilities.limits,
                  maxTextureDimension2D: 8192
                }
              }
            })
          : new NullDevice({
              capabilities: {
                ...baseDevice.capabilities,
                features: new Map([
                  ...baseDevice.capabilities.features,
                  ['compute', { status: 'unsupported' as const }],
                  ['storage-buffer', { status: 'unsupported' as const }]
                ]),
                queues: [{ role: 'graphics' as const, status: 'native' as const }],
                limits: {
                  ...baseDevice.capabilities.limits,
                  maxColorAttachments: 4,
                  maxTextureDimension2D: 8192
                },
                formats: new Map([
                  ...baseDevice.capabilities.formats,
                  [
                    'rgba32uint',
                    {
                      sample: true,
                      filter: false,
                      render: true,
                      blend: false,
                      storage: false,
                      copySrc: true,
                      copyDst: true,
                      sampleCounts: [1]
                    }
                  ]
                ])
              }
            });
      const surface = new NullSurface({ id: Symbol(backend), kind: 'offscreen' });
      surface.configure(
        device,
        {
          format: 'rgba8unorm',
          colorSpace: 'srgb',
          width: 800,
          height: 600,
          alphaMode: 'opaque',
          presentMode: 'fifo'
        },
        1
      );
      const graphics = {
        backend,
        adapter: {} as never,
        device,
        surface,
        lost: new Promise(() => undefined),
        subscribe: () => () => true,
        resize: () => undefined,
        destroy: async () => undefined
      } satisfies BrowserGraphicsSession;

      const meshHandle = createAssetHandle(MeshAssetType, 'mesh.test');
      const opaqueMatHandle = createAssetHandle(MaterialAssetType, 'mat.opaque');
      const transMatHandle = createAssetHandle(MaterialAssetType, 'mat.transparent');

      const opaquePrep = new BaselineStandardLitPreparation({
        graphics,
        mesh: { handle: meshHandle, payloadVersion: 1, data: cookedMesh.primitives[0]!.meshData },
        material: { handle: opaqueMatHandle, payloadVersion: 1, material: opaqueMaterial },
        featurePolicyKey: 'baseline',
        viewId: 'view.main',
        environment: undefined,
        environmentLighting: {
          diffuseIrradiance: [0.1, 0.1, 0.1],
          intensity: 1,
          radianceTint: [1, 1, 1]
        }
      });

      const transPrep = new BaselineStandardLitPreparation({
        graphics,
        mesh: { handle: meshHandle, payloadVersion: 1, data: cookedMesh.primitives[0]!.meshData },
        material: { handle: transMatHandle, payloadVersion: 1, material: transparentMaterial },
        featurePolicyKey: 'baseline',
        viewId: 'view.main',
        environment: undefined,
        environmentLighting: {
          diffuseIrradiance: [0.1, 0.1, 0.1],
          intensity: 1,
          radianceTint: [1, 1, 1]
        }
      });

      const view = {
        viewId: 'view.main',
        camera: 10 as RenderEntityId,
        revision: 1,
        layerMask: 1,
        view: new Array(16).fill(0),
        projection: new Array(16).fill(0),
        viewProjection: new Array(16).fill(0),
        inverseViewProjection: new Array(16).fill(0),
        cameraPosition: [0, 0, 5] as const,
        unjitteredProjection: new Array(16).fill(0),
        unjitteredViewProjection: new Array(16).fill(0),
        viewportPixels: { x: 0, y: 0, width: 800, height: 600 },
        jitterPixels: [0, 0] as const,
        depthMode: 'standard' as const,
        projectionKind: 'perspective' as const,
        near: 0.1,
        far: 1000
      };

      const baseTransform = {
        matrix: new Array(16).fill(0),
        normalMatrix: new Array(9).fill(0),
        previousMatrix: new Array(16).fill(0),
        determinantSign: 1,
        worldVersion: 1
      };

      const opaquePacket = opaquePrep.createPacket({
        entity: 1 as RenderEntityId,
        transform: baseTransform,
        view
      });
      expect(opaquePacket.phase).toBe('opaque');

      // Create multiple transparent packets with varied distances
      const transPacketNear = {
        ...transPrep.createPacket({ entity: 2 as RenderEntityId, transform: baseTransform, view }),
        distance: 1.5,
        insertionOrder: 0
      };
      const transPacketFar = {
        ...transPrep.createPacket({ entity: 3 as RenderEntityId, transform: baseTransform, view }),
        distance: 8.0,
        insertionOrder: 1
      };
      const transPacketMid = {
        ...transPrep.createPacket({ entity: 4 as RenderEntityId, transform: baseTransform, view }),
        distance: 4.2,
        insertionOrder: 2
      };

      // 4. Transparent Queue Sorting Verification
      const phaseResult = buildPreparedDrawPhase('view.main', 'transparent', [
        transPacketNear,
        transPacketFar,
        transPacketMid
      ]);

      expect(phaseResult.skipped).toHaveLength(0);
      expect(phaseResult.snapshot.packets).toHaveLength(3);
      // Back-to-front sorting: Far (8.0) -> Mid (4.2) -> Near (1.5)
      expect(phaseResult.snapshot.packets[0]!.entity).toBe(3);
      expect(phaseResult.snapshot.packets[1]!.entity).toBe(4);
      expect(phaseResult.snapshot.packets[2]!.entity).toBe(2);

      // 5. Baseline Frame Execution Verification
      const lightList = opaquePrep.createLightListFrame({
        viewLayerMask: 1,
        lights: [],
        receivers: []
      });

      const renderer = new BaselineRenderer({ graphics });
      const frameResult = renderer.frame({
        status: 'ready',
        view: {
          id: 'view.main',
          camera: 10 as RenderEntityId,
          surface: 'main',
          viewport: { x: 0, y: 0, width: 800, height: 600 },
          layerMask: 1,
          featurePolicyKey: 'baseline',
          historyKey: 'view.main-history'
        },
        packets: [opaquePacket, ...phaseResult.snapshot.packets],
        environment: opaquePrep.environmentFrame,
        lightList,
        shadowReceiver: opaquePrep.disabledShadowReceiver,
        postColor: opaquePrep.postColor,
        deviceGeneration: device.generation,
        surfaceGeneration: surface.generation
      });

      expect(frameResult.status).toBe('rendered');
      if (frameResult.status === 'rendered') {
        expect(frameResult.indexedDrawCalls).toBe(1);
      }

      lightList.release();
      await opaquePrep.dispose();
      await transPrep.dispose();
    }
  });
});
