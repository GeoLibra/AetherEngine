import {
  App,
  BrowserRunner,
  CameraRenderSource,
  DirectionalLightSource,
  FrameTimeResource,
  Mat4,
  MaterialAssetType,
  MeshAssetType,
  MeshRenderSource,
  Quat,
  TimePlugin,
  WorldTransform,
  Vec3Math,
  createAssetHandle,
  createBaselineRenderingPlugin,
  createBrowserGraphics,
  definePlugin,
  defineResource,
  defineTagComponent,
  parseGlbContainer,
  adaptGltfToCanonical,
  decodeBrowserImageTexture,
  cookCanonicalMeshDocument,
  cookCanonicalTexture,
  cookCanonicalSampler,
  cookCanonicalMaterial,
  cookCanonicalScene,
  CookedTextureRegistry,
  BaselineRenderDiagnosticsResource,
  type BaselineRenderDiagnostics,
  type BrowserGraphicsSession,
  type DirectionalLightSourceView,
  type EnvironmentAsset,
  type Vec3,
  type ViewBackground,
  type WorldTransformView
} from '@aether/engine';
import { DemandDrivenRunner } from '../../demand-driven-runner';

export interface DamagedHelmetDiagnostics {
  readonly vertexCount: number;
  readonly indexCount: number;
  readonly hasTangents: boolean;
  readonly textureCount: number;
  readonly backend: string;
}

export interface MountedDamagedHelmetScene {
  readonly backend: BrowserGraphicsSession['backend'];
  readonly environmentMode: 'hdr' | 'synthetic';
  readonly backgroundMode?: 'hdr' | 'solid' | 'none';
  diagnostics(): BaselineRenderDiagnostics | undefined;
  modelDiagnostics(): DamagedHelmetDiagnostics;
  nativeMetrics(): unknown;
  validationErrors(): readonly string[];
  runtimeErrors(): readonly string[];
  nativeError(): number | undefined;
  setRotation(angleRadians: number): Promise<void> | void;
  setCastsShadow(enabled: boolean): void;
  setSunlight(enabled: boolean): void;
  setLightDirection(direction: readonly [number, number, number]): void;
  setBackgroundMultiplier(value: number): void;
  setEnvironmentIntensity(value: number): void;
  resize(width: number, height: number): Promise<void> | void;
  destroy(): Promise<void>;
}

export interface DamagedHelmetSceneOptions {
  readonly preference?: readonly BrowserGraphicsSession['backend'][];
  readonly animate?: boolean;
  readonly ground?: boolean;
  readonly environment?: 'relax_inn' | 'venice_sunset' | 'hdr' | 'synthetic' | (string & {});
  readonly background?: 'hdr' | 'solid' | 'none' | ViewBackground;
  readonly backgroundMultiplier?: number;
  readonly sunlight?: boolean;
  readonly modelUrl?: string;
  readonly environmentIntensity?: number;
  readonly diffuseIrradiance?: readonly [number, number, number];
  readonly radianceTint?: readonly [number, number, number];
}

const HelmetRotatingTag = defineTagComponent({
  id: 'damaged-helmet.rotating',
  version: 1,
  name: 'HelmetRotating'
});

const HelmetModelDiagnosticsResource = defineResource<DamagedHelmetDiagnostics>(
  'damaged-helmet.model-diagnostics'
);

const INITIAL_LIGHT_DIRECTION: Vec3 = [-0.6, -1.0, -0.7];

async function loadEnvironmentAsset(environmentName = 'relax_inn'): Promise<EnvironmentAsset> {
  const basePath = `/assets/environment/${environmentName}`;
  const [manifestRes, irrRes, radRes, lutManifestRes, lutBinRes] = await Promise.all([
    fetch(`${basePath}/manifest.json`),
    fetch(`${basePath}/irradiance.bin`),
    fetch(`${basePath}/radiance.bin`),
    fetch(`${basePath}/brdf_lut.json`),
    fetch(`${basePath}/brdf_lut.bin`)
  ]);

  if (!manifestRes.ok || !irrRes.ok || !radRes.ok || !lutManifestRes.ok || !lutBinRes.ok) {
    throw new Error(`Failed to fetch ${environmentName} HDR environment artifacts.`);
  }

  const [manifestJson, irrBuf, radBuf, lutJson, lutBuf] = await Promise.all([
    manifestRes.json(),
    irrRes.arrayBuffer(),
    radRes.arrayBuffer(),
    lutManifestRes.json(),
    lutBinRes.arrayBuffer()
  ]);

  return Object.freeze({
    assetId: `environment.${environmentName}` as any,
    artifact: manifestJson,
    irradianceBytes: new Uint8Array(irrBuf),
    radianceBytes: new Uint8Array(radBuf),
    brdfLutArtifact: lutJson,
    brdfLutBytes: new Uint8Array(lutBuf)
  }) as unknown as EnvironmentAsset;
}

export async function mountDamagedHelmetScene(
  canvas: HTMLCanvasElement,
  options: DamagedHelmetSceneOptions = {}
): Promise<MountedDamagedHelmetScene> {
  const size = physicalSize(canvas);

  const graphics = await createBrowserGraphics({
    canvas,
    preference: options.preference ?? ['webgpu', 'webgl2'],
    device: { requiredFeatures: [], optionalFeatures: [], label: 'DamagedHelmet glTF PBR' },
    surface: { ...size, alphaMode: 'opaque' },
    webgl2ClipControl: false
  });

  const gl = canvas.getContext('webgl2');
  const runtimeErrors: string[] = [];
  const handleWindowError = (event: ErrorEvent) => {
    runtimeErrors.push(event.error instanceof Error ? event.error.message : String(event.error));
  };
  const handleWindowRejection = (event: PromiseRejectionEvent) => {
    runtimeErrors.push(event.reason instanceof Error ? event.reason.message : String(event.reason));
  };
  window.addEventListener('error', handleWindowError);
  window.addEventListener('unhandledrejection', handleWindowRejection);

  // 1. Fetch and parse DamagedHelmet.glb
  const modelUrl = options.modelUrl ?? '/assets/models/DamagedHelmet.glb';
  const glbResponse = await fetch(modelUrl);
  if (!glbResponse.ok) {
    throw new Error(`Failed to load glTF model from ${modelUrl}: HTTP ${glbResponse.status}`);
  }
  const glbArrayBuffer = await glbResponse.arrayBuffer();
  const rawGlb = parseGlbContainer(new Uint8Array(glbArrayBuffer));

  // 2. Adapt to canonical documents
  const bundle = adaptGltfToCanonical(rawGlb, { assetPrefix: 'damaged-helmet' });
  const rawMeshDoc = bundle.meshes[0];
  const rawMatDoc = bundle.materials[0];
  if (!rawMeshDoc || !rawMatDoc) {
    throw new Error('glTF model does not contain required mesh or material.');
  }

  // 3. Decode embedded JPEG/PNG textures in browser
  const decodedTextures = await Promise.all(
    bundle.textures.map((tex) => decodeBrowserImageTexture(tex))
  );

  // 4. Cook textures with appropriate PBR roles
  const registry = new CookedTextureRegistry();
  for (const sampler of bundle.samplers) {
    registry.registerSampler(cookCanonicalSampler(sampler));
  }

  // Material textures in DamagedHelmet:
  // slot 0: baseColor, slot 1: metallicRoughness, slot 2: emissive, slot 3: occlusion, slot 4: normal
  for (let i = 0; i < decodedTextures.length; i += 1) {
    const tex = decodedTextures[i]!;
    if (i === 0) registry.registerTexture(cookCanonicalTexture(tex, 'base-color'));
    else if (i === 1) registry.registerTexture(cookCanonicalTexture(tex, 'metallic-roughness'));
    else if (i === 2) registry.registerTexture(cookCanonicalTexture(tex, 'emissive'));
    else if (i === 3) registry.registerTexture(cookCanonicalTexture(tex, 'occlusion'));
    else if (i === 4) registry.registerTexture(cookCanonicalTexture(tex, 'normal'));
    else registry.registerTexture(cookCanonicalTexture(tex, 'base-color'));
  }

  // Pre-upload textures to live GPU device
  registry.prepare(graphics.device);

  // 5. Cook geometry (computes MikkTSpace tangents for 14,556 vertices)
  const cookedMesh = cookCanonicalMeshDocument(rawMeshDoc, { materials: [rawMatDoc] });
  const primitive = cookedMesh.primitives[0]!;
  const cookedMaterial = cookCanonicalMaterial(rawMatDoc, { samplers: bundle.samplers });

  // Dynamically cook scene graph to compute node world transforms from glTF
  const cookedScene = cookCanonicalScene(bundle.scene);
  const meshNode =
    cookedScene.nodes.find((node) => node.meshId === rawMeshDoc.id) ?? cookedScene.nodes[0];
  const baseModelMatrix: Float32Array = new Float32Array(
    meshNode?.worldTransform ?? Mat4.identity()
  );

  const modelDiag: DamagedHelmetDiagnostics = Object.freeze({
    vertexCount: primitive.meshData.vertexCount,
    indexCount: primitive.meshData.indices?.data.length ?? 0,
    hasTangents: primitive.hasGeneratedTangents,
    textureCount: decodedTextures.length,
    backend: graphics.backend
  });

  // 6. Environment & Background
  const rawEnv = options.environment ?? 'relax_inn';
  const useHdr = rawEnv !== 'synthetic';
  const envName = rawEnv === 'hdr' ? 'relax_inn' : rawEnv;
  let environmentAsset: EnvironmentAsset | undefined;
  if (useHdr) {
    try {
      environmentAsset = await loadEnvironmentAsset(envName);
    } catch {
      // Fall back to synthetic if environment artifacts missing
    }
  }

  let activeBackground: ViewBackground;
  if (options.background && typeof options.background === 'object') {
    activeBackground = options.background;
  } else {
    const bgMode = options.background ?? (environmentAsset ? 'hdr' : 'solid');
    if (bgMode === 'hdr' && environmentAsset) {
      activeBackground = {
        kind: 'environment',
        source: 'view-environment',
        representation: 'radiance-level-zero',
        multiplier: options.backgroundMultiplier ?? 1.0
      };
    } else if (bgMode === 'solid') {
      activeBackground = { kind: 'solid', colorLinear: [6, 8, 12] };
    } else {
      activeBackground = { kind: 'none' };
    }
  }

  const defaultDiffuse: [number, number, number] =
    envName === 'relax_inn' ? [250, 250, 250] : [300, 350, 500];
  const defaultRadianceTint: [number, number, number] =
    envName === 'relax_inn' ? [120, 120, 120] : [100, 120, 180];

  const meshHandle = createAssetHandle(MeshAssetType, 'mesh.damaged-helmet');
  const materialHandle = createAssetHandle(MaterialAssetType, 'material.damaged-helmet');

  const renderingPlugin = createBaselineRenderingPlugin({
    graphics,
    mesh: { handle: meshHandle, payloadVersion: 1, data: primitive.meshData },
    material: { handle: materialHandle, payloadVersion: 1, material: cookedMaterial },
    materialResources: registry,
    ...(environmentAsset
      ? {
          environment: {
            asset: environmentAsset,
            lighting: {
              intensity: options.environmentIntensity ?? 1.0,
              radianceTint: options.radianceTint ?? defaultRadianceTint,
              diffuseIrradiance: options.diffuseIrradiance ?? defaultDiffuse
            }
          }
        }
      : {}),
    background: activeBackground
  });

  let sunlight = options.sunlight !== false;
  let castsShadow = true;
  let forcedRotation: number | null = null;
  const isAnimate = options.animate !== false;
  let lightDirection: Vec3 = [...INITIAL_LIGHT_DIRECTION];

  const app = new App()
    .addPlugin(TimePlugin)
    .addPlugin(renderingPlugin)
    .addPlugin(
      definePlugin({
        id: 'example.damaged-helmet-scene',
        dependencies: ['aether.time', 'aether.baseline-rendering'],
        build(builder) {
          builder.insertResource(HelmetModelDiagnosticsResource, modelDiag);

          builder.addSystem('PreStartup', {
            id: 'example.damaged-helmet.register-tag',
            run(world) {
              world.registerComponent(HelmetRotatingTag);
            }
          });

          builder.addSystem('Startup', {
            id: 'example.damaged-helmet.spawn',
            run(world) {
              // Camera looking at center from distance ~3.0
              world
                .spawn()
                .insert(WorldTransform, createCameraTransform([0, 0.2, 3.2]))
                .insert(CameraRenderSource, {
                  projection: {
                    kind: 'perspective',
                    near: 0.1,
                    far: 100,
                    verticalFovRadians: Math.PI / 4
                  },
                  viewportRect: { x: 0, y: 0, width: 1, height: 1 },
                  layerMask: 1,
                  depthMode: 'standard',
                  historyKey: 'example.helmet-camera'
                })
                .build();

              // DamagedHelmet Model entity
              world
                .spawn()
                .insert(WorldTransform, createModelTransform([0, 0, 0], baseModelMatrix))
                .insert(HelmetRotatingTag, {})
                .insert(MeshRenderSource, {
                  mesh: { handle: meshHandle, payloadVersion: 1 },
                  submesh: 0,
                  materials: [{ slot: 0, handle: materialHandle, payloadVersion: 1 }],
                  localBounds: primitive.meshData.bounds,
                  visible: true,
                  layerMask: 1
                })
                .build();

              // Directional sunlight
              world
                .spawn()
                .insert(DirectionalLightSource, {
                  direction: lightDirection,
                  colorLinear: [1, 0.96, 0.9],
                  illuminanceLux: sunlight ? 15_000 : 0,
                  enabled: sunlight,
                  layerMask: 1,
                  castsShadow
                })
                .build();
            }
          });

          builder.addSystem('Update', {
            id: 'example.damaged-helmet.update',
            reads: [FrameTimeResource],
            writes: [WorldTransform, DirectionalLightSource],
            run(world) {
              const frameTime = world.getResource(FrameTimeResource);
              const angle =
                forcedRotation ?? (isAnimate && frameTime ? frameTime.elapsed * 0.5 : 0);

              for (const [entity, transform] of world.query([WorldTransform, HelmetRotatingTag])) {
                updateModelRotation(transform as WorldTransformView, angle, baseModelMatrix);
                world.markComponentChanged(entity, WorldTransform);
              }

              // Update directional light if changed
              const lights = [...world.query([DirectionalLightSource])];
              for (const [entity, lightSource] of lights) {
                const source = lightSource as DirectionalLightSourceView;
                if (
                  source.castsShadow !== castsShadow ||
                  source.enabled !== sunlight ||
                  !Vec3Math.equals(source.direction, lightDirection)
                ) {
                  world.insertComponent(entity, DirectionalLightSource, {
                    ...source,
                    castsShadow,
                    enabled: sunlight,
                    illuminanceLux: sunlight ? 15_000 : 0,
                    direction: lightDirection
                  });
                }
              }
            }
          });
        }
      })
    );

  try {
    await app.startup();
  } catch (error) {
    window.removeEventListener('error', handleWindowError);
    window.removeEventListener('unhandledrejection', handleWindowRejection);
    await app.destroy();
    registry.dispose();
    await graphics.destroy();
    throw error;
  }

  const demandRunner = !isAnimate ? new DemandDrivenRunner() : undefined;
  const runner =
    demandRunner ??
    new BrowserRunner({
      request: (cb) => requestAnimationFrame(cb),
      cancel: (id) => cancelAnimationFrame(id)
    });

  void app.run(runner).catch((error: unknown) => {
    runtimeErrors.push(error instanceof Error ? error.message : String(error));
  });

  if (demandRunner !== undefined) {
    await advanceUntilRendered(demandRunner, () =>
      app.getResource(BaselineRenderDiagnosticsResource)
    );
  }

  return Object.freeze({
    backend: graphics.backend,
    environmentMode: useHdr && environmentAsset ? 'hdr' : 'synthetic',
    backgroundMode: (activeBackground.kind === 'environment'
      ? 'hdr'
      : activeBackground.kind === 'solid'
        ? 'solid'
        : 'none') as 'hdr' | 'solid' | 'none',
    diagnostics: () => app.getResource(BaselineRenderDiagnosticsResource),
    modelDiagnostics: () => app.getResource(HelmetModelDiagnosticsResource) ?? modelDiag,
    nativeMetrics: () => {
      const metrics = Reflect.get(graphics.device.queue, 'metrics');
      return typeof metrics === 'function'
        ? (Reflect.apply(metrics, graphics.device.queue, []) as unknown)
        : undefined;
    },
    validationErrors: () => browserValidationErrors(graphics),
    runtimeErrors: () => Object.freeze([...runtimeErrors]),
    nativeError: () => gl?.getError(),
    async setRotation(angleRadians: number) {
      if (!Number.isFinite(angleRadians)) throw new Error('Scene rotation angle must be finite.');
      const previousFrame = app.getResource(BaselineRenderDiagnosticsResource)?.frame ?? 0;
      forcedRotation = angleRadians;
      if (demandRunner !== undefined) {
        await advanceUntilRendered(
          demandRunner,
          () => app.getResource(BaselineRenderDiagnosticsResource),
          'rendered',
          previousFrame
        );
      }
    },
    setCastsShadow(enabled: boolean) {
      castsShadow = enabled;
      demandRunner?.frame();
    },
    setSunlight(enabled: boolean) {
      sunlight = enabled;
      demandRunner?.frame();
    },
    setLightDirection(direction: readonly [number, number, number]) {
      lightDirection = Vec3Math.normalize(direction as Vec3, 'Light direction');
      demandRunner?.frame();
    },
    setBackgroundMultiplier(value: number) {
      if (activeBackground.kind === 'environment') {
        renderingPlugin.setBackground({
          kind: 'environment',
          source: 'view-environment',
          representation: 'radiance-level-zero',
          multiplier: value
        });
      }
      demandRunner?.frame();
    },
    setEnvironmentIntensity(value: number) {
      renderingPlugin.setEnvironmentIntensity(value);
      demandRunner?.frame();
    },
    async resize(width: number, height: number) {
      const previousFrame = app.getResource(BaselineRenderDiagnosticsResource)?.frame ?? 0;
      graphics.resize({ width, height });
      if (demandRunner !== undefined) {
        await advanceUntilRendered(
          demandRunner,
          () => app.getResource(BaselineRenderDiagnosticsResource),
          width === 0 || height === 0 ? 'skipped' : 'rendered',
          previousFrame
        );
      }
    },
    async destroy() {
      window.removeEventListener('error', handleWindowError);
      window.removeEventListener('unhandledrejection', handleWindowRejection);
      app.stop('helmet-demo-unmounted');
      await app.destroy();
      registry.dispose();
      await graphics.destroy();
    }
  });
}

function physicalSize(canvas: HTMLCanvasElement): { width: number; height: number } {
  const bounds = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  return {
    width: Math.max(0, Math.round(bounds.width * scale)),
    height: Math.max(0, Math.round(bounds.height * scale))
  };
}

function createCameraTransform(position: Vec3) {
  const [x, y, z] = position;
  return {
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1],
    previousMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1],
    normalMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    determinantSign: 1,
    worldVersion: 1
  };
}

function createModelTransform(translation: Vec3, baseMatrix?: ArrayLike<number>) {
  const [x, y, z] = translation;
  const initial = baseMatrix
    ? new Float32Array(baseMatrix)
    : new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
  if (baseMatrix) {
    initial[12] = (initial[12] ?? 0) + x;
    initial[13] = (initial[13] ?? 0) + y;
    initial[14] = (initial[14] ?? 0) + z;
  }
  return {
    matrix: new Float32Array(initial),
    previousMatrix: new Float32Array(initial),
    normalMatrix: new Float32Array([
      initial[0]!,
      initial[1]!,
      initial[2]!,
      initial[4]!,
      initial[5]!,
      initial[6]!,
      initial[8]!,
      initial[9]!,
      initial[10]!
    ]),
    determinantSign: 1,
    worldVersion: 1
  };
}

function updateModelRotation(
  worldTransform: WorldTransformView,
  angle: number,
  baseMatrix: ArrayLike<number>
): void {
  worldTransform.previousMatrix.set(worldTransform.matrix);
  const orbitMatrix = Mat4.fromTRS(
    [0, 0, 0],
    Quat.fromEulerYXZ([0.15, angle + Math.PI / 4, 0]),
    [1, 1, 1]
  );
  const matrix = Mat4.multiply(orbitMatrix, baseMatrix);
  worldTransform.matrix.set(matrix);
  worldTransform.normalMatrix.set([
    matrix[0]!,
    matrix[1]!,
    matrix[2]!,
    matrix[4]!,
    matrix[5]!,
    matrix[6]!,
    matrix[8]!,
    matrix[9]!,
    matrix[10]!
  ]);
  worldTransform.worldVersion += 1;
}

function browserValidationErrors(graphics: BrowserGraphicsSession): readonly string[] {
  const diagnostics = Reflect.get(graphics.adapter, 'diagnostics');
  if (typeof diagnostics !== 'object' || diagnostics === null) return Object.freeze([]);
  const list = Reflect.get(diagnostics, 'list');
  if (typeof list !== 'function') return Object.freeze([]);
  return Object.freeze(
    (Reflect.apply(list, diagnostics, []) as readonly unknown[]).map((entry) => {
      if (typeof entry !== 'object' || entry === null) return String(entry);
      const message = Reflect.get(entry, 'message');
      return typeof message === 'string' ? message : String(entry);
    })
  );
}

async function advanceUntilRendered(
  demandRunner: DemandDrivenRunner,
  diagnostics: () => BaselineRenderDiagnostics | undefined,
  expected: 'rendered' | 'skipped' = 'rendered',
  sinceFrame = -1
): Promise<void> {
  for (let frame = 0; frame < 30; frame++) {
    demandRunner.frame();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const diag = diagnostics();
    if (diag?.status === expected && diag.frame > sinceFrame) return;
  }
  throw new Error(
    `DamagedHelmet renderer did not reach ${expected} within 30 deterministic frames.`
  );
}
