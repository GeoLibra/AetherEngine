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
  buildStableCascade,
  computeCascadeSplits,
  createAssetHandle,
  createBaselineRenderingPlugin,
  createBoxMeshData,
  createBrowserGraphics,
  createStandardLitMaterial,
  definePlugin,
  defineResource,
  defineTagComponent,
  selectShadowRequests,
  BaselineRenderDiagnosticsResource,
  StandardLitMaterialSchema,
  type BaselineRenderDiagnostics,
  type BrowserGraphicsSession,
  type DirectionalLightSourceView,
  type EnvironmentAsset,
  type ShadowRequest,
  type Vec3,
  type WorldTransformView
} from '@aether/engine';
import { DemandDrivenRunner } from './demand-driven-runner';

export interface CascadeSliceDiagnostics {
  readonly cascadeIndex: number;
  readonly splitNear: number;
  readonly splitFar: number;
  readonly radius: number;
  readonly rawRadius: number;
  readonly worldUnitsPerTexel: number;
  readonly snappedCenterLightSpace: readonly [number, number, number];
  readonly boundsLightSpace: Readonly<
    Record<'left' | 'right' | 'top' | 'bottom' | 'near' | 'far', number>
  >;
}

export interface CsmSceneDiagnostics {
  readonly castsShadow: boolean;
  readonly lightDirection: readonly [number, number, number];
  readonly shadowDistance: number;
  readonly cascadeCount: number;
  readonly cascades: readonly CascadeSliceDiagnostics[];
  readonly usedTexels: number;
  readonly acceptedRequests: number;
}

export interface MountedAetherScene {
  readonly backend: BrowserGraphicsSession['backend'];
  readonly environmentMode: 'hdr' | 'synthetic';
  diagnostics(): BaselineRenderDiagnostics | undefined;
  csmDiagnostics(): CsmSceneDiagnostics | undefined;
  nativeMetrics(): unknown;
  validationErrors(): readonly string[];
  runtimeErrors(): readonly string[];
  /** Overrides automatic rotation with a deterministic YXZ angle in radians. */
  setRotation(angleRadians: number): Promise<void> | void;
  setCastsShadow(enabled: boolean): void;
  setSunlight(enabled: boolean): void;
  setRoughness(roughness: number): void;
  setMetallic(metallic: number): void;
  setLightDirection(direction: readonly [number, number, number]): void;
  setShadowDistance(distance: number): void;
  resize(width: number, height: number): Promise<void> | void;
  destroy(): Promise<void>;
}

export interface AetherSceneOptions {
  readonly preference?: readonly BrowserGraphicsSession['backend'][];
  /** Enables frame-time rotation; defaults to true and is disabled only for deterministic capture. */
  readonly animate?: boolean;
  /** Spawns a ground receiver mesh; defaults to true. */
  readonly ground?: boolean;
  /** Environment IBL lighting source: 'hdr' (Venice Sunset) or 'synthetic' (fallback). Defaults to 'hdr'. */
  readonly environment?: 'hdr' | 'synthetic';
  /** Material roughness [0.0 = mirror, 1.0 = rough]. Defaults to 0.15. */
  readonly roughness?: number;
  /** Material metallic [0.0 = dielectric, 1.0 = metal]. Defaults to 0.85. */
  readonly metallic?: number;
  /** Enables directional sunlight; defaults to true. */
  readonly sunlight?: boolean;
}

const RotatingTag = defineTagComponent({
  id: 'example.rotating',
  version: 1,
  name: 'Rotating'
});

const CsmDiagnosticsResource = defineResource<CsmSceneDiagnostics>('example.csm-diagnostics');

const INITIAL_LIGHT_DIRECTION: Vec3 = [-0.5, -1, -0.75];

const INITIAL_CSM_DIAGNOSTICS: CsmSceneDiagnostics = Object.freeze({
  castsShadow: true,
  lightDirection: INITIAL_LIGHT_DIRECTION,
  shadowDistance: 25,
  cascadeCount: 3,
  cascades: Object.freeze([]),
  usedTexels: 0,
  acceptedRequests: 0
});

/** Fetches cooked Venice Sunset HDR artifacts from the public assets directory. */
async function loadDemoEnvironmentAsset(
  basePath = '/assets/environment/venice_sunset'
): Promise<EnvironmentAsset> {
  const [manifestRes, irrRes, radRes, lutManifestRes, lutBinRes] = await Promise.all([
    fetch(`${basePath}/manifest.json`),
    fetch(`${basePath}/irradiance.bin`),
    fetch(`${basePath}/radiance.bin`),
    fetch(`${basePath}/brdf_lut.json`),
    fetch(`${basePath}/brdf_lut.bin`)
  ]);

  if (!manifestRes.ok || !irrRes.ok || !radRes.ok || !lutManifestRes.ok || !lutBinRes.ok) {
    throw new Error('Failed to fetch Venice Sunset HDR environment artifacts.');
  }

  const [manifestJson, irrBuf, radBuf, lutJson, lutBuf] = await Promise.all([
    manifestRes.json(),
    irrRes.arrayBuffer(),
    radRes.arrayBuffer(),
    lutManifestRes.json(),
    lutBinRes.arrayBuffer()
  ]);

  return Object.freeze({
    assetId: 'environment.venice_sunset' as any,
    artifact: manifestJson,
    irradianceBytes: new Uint8Array(irrBuf),
    radianceBytes: new Uint8Array(radBuf),
    brdfLutArtifact: lutJson,
    brdfLutBytes: new Uint8Array(lutBuf)
  }) as unknown as EnvironmentAsset;
}

/** Mounts the public baseline renderer and one MainWorld-authored scene with real-time CSM on a canvas. */
export async function mountAetherScene(
  canvas: HTMLCanvasElement,
  options: AetherSceneOptions = {}
): Promise<MountedAetherScene> {
  const size = physicalSize(canvas);
  const graphics = await createBrowserGraphics({
    canvas,
    preference: options.preference ?? ['webgpu', 'webgl2'],
    device: { requiredFeatures: [], optionalFeatures: [], label: 'Aether React example' },
    surface: { ...size, alphaMode: 'opaque' },
    webgl2ClipControl: false
  });
  let liveMetallic = options.metallic ?? 0.85;
  let liveRoughness = options.roughness ?? 0.15;
  let sunlight = options.sunlight !== false;
  const mesh = createBoxMeshData();
  const baseMaterial = createStandardLitMaterial({
    baseColor: [0.18, 0.48, 0.92, 1],
    metallic: liveMetallic,
    roughness: liveRoughness
  });

  const liveParameters = new Proxy(baseMaterial.instance.parameters, {
    get(target, prop, receiver) {
      if (prop === 'get') {
        return (field: unknown) => {
          if (field === StandardLitMaterialSchema.fields.metallic) return liveMetallic;
          if (field === StandardLitMaterialSchema.fields.roughness) return liveRoughness;
          return Reflect.apply(target.get, target, [field]);
        };
      }
      return Reflect.get(target, prop, receiver);
    }
  });

  const liveInstance = new Proxy(baseMaterial.instance, {
    get(target, prop, receiver) {
      if (prop === 'parameters') return liveParameters;
      return Reflect.get(target, prop, receiver);
    }
  });

  const material = new Proxy(baseMaterial, {
    get(target, prop, receiver) {
      if (prop === 'instance') return liveInstance;
      return Reflect.get(target, prop, receiver);
    }
  });
  const meshHandle = createAssetHandle(MeshAssetType, 'example.mesh.box');
  const materialHandle = createAssetHandle(MaterialAssetType, 'example.material.standard-lit');
  let forcedRotation = options.animate === false ? 0 : undefined;
  const includeGround = options.ground !== false;
  let castsShadow = includeGround && sunlight;
  let shadowDistance = 25;
  let lightDirection: Vec3 = INITIAL_LIGHT_DIRECTION;
  const boxTranslation: readonly [number, number, number] = includeGround
    ? [0, 0.2, -2.5]
    : [0, 0, -2];

  let environmentAsset: EnvironmentAsset | undefined;
  let activeEnvironmentMode: 'hdr' | 'synthetic' = 'synthetic';

  if (options.environment !== 'synthetic') {
    try {
      environmentAsset = await loadDemoEnvironmentAsset();
      activeEnvironmentMode = 'hdr';
    } catch (error) {
      console.warn('Could not load HDR environment, falling back to synthetic:', error);
    }
  }

  const app = new App()
    .addPlugin(TimePlugin)
    .addPlugin(
      createBaselineRenderingPlugin({
        graphics,
        mesh: { handle: meshHandle, payloadVersion: 1, data: mesh },
        material: { handle: materialHandle, payloadVersion: 1, material },
        ...(environmentAsset ? { environment: environmentAsset } : {})
      })
    )
    .addPlugin(
      definePlugin({
        id: 'example.standard-lit-scene',
        dependencies: ['aether.time', 'aether.baseline-rendering'],
        build(builder) {
          // Register CSM diagnostics initial resource to allow replaceResource in systems
          builder.insertResource(CsmDiagnosticsResource, INITIAL_CSM_DIAGNOSTICS);

          builder.addSystem('PreStartup', {
            id: 'example.standard-lit-scene.register-tag',
            run(world) {
              world.registerComponent(RotatingTag);
            }
          });

          builder.addSystem('Startup', {
            id: 'example.standard-lit-scene.spawn',
            run(world) {
              // Camera entity
              world
                .spawn()
                .insert(WorldTransform, transform([0, 0, 0]))
                .insert(CameraRenderSource, {
                  projection: {
                    kind: 'perspective',
                    near: 0.1,
                    far: 100,
                    verticalFovRadians: Math.PI / 3
                  },
                  viewportRect: { x: 0, y: 0, width: 1, height: 1 },
                  layerMask: 1,
                  depthMode: 'standard',
                  historyKey: 'example.main-camera'
                })
                .build();

              const meshSource = {
                mesh: { handle: meshHandle, payloadVersion: 1 },
                submesh: 0,
                materials: [{ slot: 0, handle: materialHandle, payloadVersion: 1 }],
                localBounds: mesh.bounds,
                visible: true,
                layerMask: 1
              };
              world
                .spawn()
                .insert(WorldTransform, transform(boxTranslation))
                .insert(RotatingTag, {})
                .insert(MeshRenderSource, meshSource)
                .build();

              // Receiver Ground entity (optional for acceptance test)
              if (includeGround) {
                world
                  .spawn()
                  .insert(WorldTransform, transform([0, -1.2, -2.5], [6, 0.05, 6]))
                  .insert(MeshRenderSource, meshSource)
                  .build();
              }

              // Directional Light entity
              world
                .spawn()
                .insert(DirectionalLightSource, {
                  direction: lightDirection,
                  colorLinear: [1, 0.95, 0.88],
                  illuminanceLux: sunlight ? 12_000 : 0,
                  enabled: sunlight,
                  layerMask: 1,
                  castsShadow
                })
                .build();
            }
          });

          builder.addSystem('Update', {
            id: 'example.standard-lit-scene.rotate-and-csm',
            reads: [FrameTimeResource, MeshRenderSource],
            writes: [WorldTransform, DirectionalLightSource, CsmDiagnosticsResource],
            run(world) {
              const frameTime = world.getResource(FrameTimeResource);
              if (frameTime === undefined) {
                throw new Error('Rotating scene requires the frame-time resource.');
              }
              const angle = forcedRotation ?? frameTime.elapsed * 0.8;
              for (const [entity, worldTransform] of world.query([WorldTransform, RotatingTag])) {
                rotateWorldTransform(worldTransform, angle, boxTranslation);
                world.markComponentChanged(entity, WorldTransform);
              }

              // Update directional light source parameters via immutable insertComponent
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
                    illuminanceLux: sunlight ? 12_000 : 0,
                    direction: lightDirection
                  });
                }
              }

              // Compute real-time CSM (Cascaded Shadow Maps)
              const cameraNear = 0.1;
              const cascadeCount = 3;
              const lambda = 0.8;
              const splits = computeCascadeSplits(cameraNear, shadowDistance, cascadeCount, lambda);
              const aspect =
                canvas.width > 0 && canvas.height > 0 ? canvas.width / canvas.height : 16 / 9;
              const vFov = Math.PI / 3;

              const cascades: CascadeSliceDiagnostics[] = [];
              const shadowRequests: ShadowRequest[] = [];
              let nearPlane = cameraNear;

              for (let index = 0; index < splits.length; index++) {
                const farPlane = splits[index]!;
                const corners = calculateFrustumCornersWorld(nearPlane, farPlane, vFov, aspect);
                const cascade = buildStableCascade({
                  cornersWorld: corners,
                  lightDirection,
                  usableResolution: 1024,
                  casterDepthRange: { min: -20, max: 40 },
                  radiusQuantum: 0.5
                });
                cascades.push({
                  cascadeIndex: index,
                  splitNear: nearPlane,
                  splitFar: farPlane,
                  radius: cascade.radius,
                  rawRadius: cascade.rawRadius,
                  worldUnitsPerTexel: cascade.worldUnitsPerTexel,
                  snappedCenterLightSpace: cascade.snappedCenterLightSpace,
                  boundsLightSpace: cascade.boundsLightSpace
                });
                if (castsShadow) {
                  shadowRequests.push({
                    lightEntity: 1 as unknown as never,
                    viewId: 'example.main-camera',
                    kind: 'directional-cascade',
                    subresourceIndex: index,
                    resolutionClass: 1024,
                    importance: 1 / (index + 1),
                    casterRevision: 1
                  });
                }
                nearPlane = farPlane;
              }

              const selection = selectShadowRequests(shadowRequests, {
                maxRequests: 4,
                maxTexels: 1024 * 1024 * 4
              });

              const diagnostics: CsmSceneDiagnostics = Object.freeze({
                castsShadow,
                lightDirection,
                shadowDistance,
                cascadeCount,
                cascades: Object.freeze(cascades),
                usedTexels: selection.usedTexels,
                acceptedRequests: selection.accepted.length
              });
              world.replaceResource(CsmDiagnosticsResource, diagnostics);
            }
          });
        }
      })
    );
  const observer = new ResizeObserver(() => graphics.resize(physicalSize(canvas)));
  observer.observe(canvas);

  try {
    await app.startup();
  } catch (error) {
    observer.disconnect();
    await app.destroy();
    await graphics.destroy();
    throw error;
  }
  const runtimeErrors: string[] = [];
  const demandRunner = options.animate === false ? new DemandDrivenRunner() : undefined;
  const runner =
    demandRunner ??
    new BrowserRunner({
      request: (callback) => requestAnimationFrame(callback),
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

  let destroyed = false;
  return Object.freeze({
    backend: graphics.backend,
    environmentMode: activeEnvironmentMode,
    diagnostics: () => app.getResource(BaselineRenderDiagnosticsResource),
    csmDiagnostics: () => app.getResource(CsmDiagnosticsResource),
    nativeMetrics: () => {
      const metrics = Reflect.get(graphics.device.queue, 'metrics');
      return typeof metrics === 'function'
        ? Reflect.apply(metrics, graphics.device.queue, [])
        : undefined;
    },
    validationErrors: () => browserValidationErrors(graphics),
    runtimeErrors: () => Object.freeze([...runtimeErrors]),
    async setRotation(angleRadians: number) {
      if (!Number.isFinite(angleRadians)) throw new Error('Scene rotation angle must be finite.');
      const previousFrame = app.getResource(BaselineRenderDiagnosticsResource)?.frame ?? 0;
      forcedRotation = angleRadians;
      if (demandRunner !== undefined)
        await advanceUntilRendered(
          demandRunner,
          () => app.getResource(BaselineRenderDiagnosticsResource),
          'rendered',
          previousFrame
        );
    },
    setCastsShadow(enabled: boolean) {
      castsShadow = enabled;
    },
    setSunlight(enabled: boolean) {
      sunlight = enabled;
      castsShadow = includeGround && sunlight;
    },
    setRoughness(value: number) {
      if (Number.isFinite(value)) {
        liveRoughness = Math.max(0, Math.min(1, value));
        demandRunner?.frame();
      }
    },
    setMetallic(value: number) {
      if (Number.isFinite(value)) {
        liveMetallic = Math.max(0, Math.min(1, value));
        demandRunner?.frame();
      }
    },
    setLightDirection(direction: readonly [number, number, number]) {
      lightDirection = Vec3Math.normalize(direction as Vec3, 'Light direction');
    },
    setShadowDistance(distance: number) {
      if (Number.isFinite(distance) && distance > 0.5) shadowDistance = distance;
    },
    async resize(width: number, height: number) {
      graphics.resize({ width, height });
      if (demandRunner === undefined) return;
      await advanceUntilRendered(
        demandRunner,
        () => app.getResource(BaselineRenderDiagnosticsResource),
        width === 0 || height === 0 ? 'skipped' : 'rendered'
      );
    },
    async destroy() {
      if (destroyed) return;
      destroyed = true;
      observer.disconnect();
      app.stop('example-unmounted');
      await app.destroy();
      await graphics.destroy();
    }
  });
}

async function advanceUntilRendered(
  runner: DemandDrivenRunner,
  diagnostics: () => BaselineRenderDiagnostics | undefined,
  expected: BaselineRenderDiagnostics['status'] = 'rendered',
  afterFrame = -1
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    runner.frame();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const current = diagnostics();
    if (current?.status === expected && current.frame > afterFrame) return;
  }
  throw new Error(`Baseline renderer did not reach ${expected} within 30 deterministic frames.`);
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

function calculateFrustumCornersWorld(
  near: number,
  far: number,
  verticalFovRadians: number,
  aspectRatio: number
): readonly Vec3[] {
  const tanHalfFov = Math.tan(verticalFovRadians / 2);
  const nearHeight = near * tanHalfFov;
  const nearWidth = nearHeight * aspectRatio;
  const farHeight = far * tanHalfFov;
  const farWidth = farHeight * aspectRatio;
  return [
    [-nearWidth, -nearHeight, -near],
    [nearWidth, -nearHeight, -near],
    [nearWidth, nearHeight, -near],
    [-nearWidth, nearHeight, -near],
    [-farWidth, -farHeight, -far],
    [farWidth, -farHeight, -far],
    [farWidth, farHeight, -far],
    [-farWidth, farHeight, -far]
  ];
}

function rotateWorldTransform(
  worldTransform: WorldTransformView,
  angleRadians: number,
  translation: readonly [number, number, number] = [0, 0, -2]
): void {
  worldTransform.previousMatrix.set(worldTransform.matrix);
  const matrix = Mat4.fromTRS(
    translation,
    Quat.fromEulerYXZ([angleRadians * 0.55, angleRadians, 0]),
    [1, 1, 1]
  );
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

function physicalSize(canvas: HTMLCanvasElement): { width: number; height: number } {
  const bounds = canvas.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  return {
    width: Math.max(0, Math.round(bounds.width * scale)),
    height: Math.max(0, Math.round(bounds.height * scale))
  };
}

function transform(
  translation: readonly [number, number, number],
  scale: readonly [number, number, number] = [1, 1, 1]
) {
  const [x, y, z] = translation;
  const [sx, sy, sz] = scale;
  return {
    matrix: [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, x, y, z, 1],
    previousMatrix: [sx, 0, 0, 0, 0, sy, 0, 0, 0, 0, sz, 0, x, y, z, 1],
    normalMatrix: [1 / sx, 0, 0, 0, 1 / sy, 0, 0, 0, 1 / sz],
    worldVersion: 1,
    originCell: [0, 0, 0],
    determinantSign: 1
  };
}
