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
  type BaselineRenderDiagnostics,
  type BrowserGraphicsSession,
  type DirectionalLightSourceView,
  type ShadowRequest,
  type Vec3,
  type WorldTransformView
} from '@aether/engine';

export interface CascadeSliceDiagnostics {
  readonly cascadeIndex: number;
  readonly splitNear: number;
  readonly splitFar: number;
  readonly radius: number;
  readonly rawRadius: number;
  readonly worldUnitsPerTexel: number;
  readonly snappedCenterLightSpace: readonly [number, number, number];
  readonly boundsLightSpace: {
    readonly left: number;
    readonly right: number;
    readonly top: number;
    readonly bottom: number;
    readonly near: number;
    readonly far: number;
  };
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
  diagnostics(): BaselineRenderDiagnostics | undefined;
  csmDiagnostics(): CsmSceneDiagnostics | undefined;
  nativeMetrics(): unknown;
  /** Overrides automatic rotation with a deterministic YXZ angle in radians. */
  setRotation(angleRadians: number): void;
  setCastsShadow(enabled: boolean): void;
  setLightDirection(direction: readonly [number, number, number]): void;
  setShadowDistance(distance: number): void;
  resize(width: number, height: number): void;
  destroy(): Promise<void>;
}

export interface AetherSceneOptions {
  readonly preference?: readonly BrowserGraphicsSession['backend'][];
  /** Enables frame-time rotation; defaults to true and is disabled only for deterministic capture. */
  readonly animate?: boolean;
  /** Spawns a ground receiver mesh; defaults to true. */
  readonly ground?: boolean;
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
    surface: { ...size, alphaMode: 'opaque' }
  });
  const mesh = createBoxMeshData();
  const material = createStandardLitMaterial({
    baseColor: [0.18, 0.48, 0.92, 1],
    metallic: 0.08,
    roughness: 0.42
  });
  const meshHandle = createAssetHandle(MeshAssetType, 'example.mesh.box');
  const materialHandle = createAssetHandle(MaterialAssetType, 'example.material.standard-lit');
  let forcedRotation = options.animate === false ? 0 : undefined;
  const includeGround = options.ground !== false;
  let castsShadow = includeGround;
  let shadowDistance = 25;
  let lightDirection: Vec3 = INITIAL_LIGHT_DIRECTION;
  const boxTranslation: readonly [number, number, number] = includeGround
    ? [0, 0.2, -2.5]
    : [0, 0, -2];

  const app = new App()
    .addPlugin(TimePlugin)
    .addPlugin(
      createBaselineRenderingPlugin({
        graphics,
        mesh: { handle: meshHandle, payloadVersion: 1, data: mesh },
        material: { handle: materialHandle, payloadVersion: 1, material }
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

              // Caster Box entity
              world
                .spawn()
                .insert(WorldTransform, transform(boxTranslation))
                .insert(RotatingTag, {})
                .insert(MeshRenderSource, {
                  mesh: { handle: meshHandle, payloadVersion: 1 },
                  submesh: 0,
                  materials: [{ slot: 0, handle: materialHandle, payloadVersion: 1 }],
                  localBounds: mesh.bounds,
                  visible: true,
                  layerMask: 1
                })
                .build();

              // Receiver Ground entity (optional for acceptance test)
              if (includeGround) {
                world
                  .spawn()
                  .insert(WorldTransform, transform([0, -1.2, -2.5], [6, 0.05, 6]))
                  .insert(MeshRenderSource, {
                    mesh: { handle: meshHandle, payloadVersion: 1 },
                    submesh: 0,
                    materials: [{ slot: 0, handle: materialHandle, payloadVersion: 1 }],
                    localBounds: mesh.bounds,
                    visible: true,
                    layerMask: 1
                  })
                  .build();
              }

              // Directional Light entity
              world
                .spawn()
                .insert(DirectionalLightSource, {
                  direction: lightDirection,
                  colorLinear: [1, 0.95, 0.88],
                  illuminanceLux: 12_000,
                  enabled: true,
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
                  !Vec3Math.equals(source.direction, lightDirection)
                ) {
                  world.insertComponent(entity, DirectionalLightSource, {
                    ...source,
                    castsShadow,
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
  void app.run(
    new BrowserRunner({
      request: (callback) => requestAnimationFrame(callback),
      cancel: (id) => cancelAnimationFrame(id)
    })
  );

  let destroyed = false;
  return Object.freeze({
    backend: graphics.backend,
    diagnostics: () => app.getResource(BaselineRenderDiagnosticsResource),
    csmDiagnostics: () => app.getResource(CsmDiagnosticsResource),
    nativeMetrics: () => {
      const metrics = Reflect.get(graphics.device.queue, 'metrics');
      return typeof metrics === 'function'
        ? Reflect.apply(metrics, graphics.device.queue, [])
        : undefined;
    },
    setRotation(angleRadians: number) {
      if (!Number.isFinite(angleRadians)) throw new Error('Scene rotation angle must be finite.');
      forcedRotation = angleRadians;
    },
    setCastsShadow(enabled: boolean) {
      castsShadow = enabled;
    },
    setLightDirection(direction: readonly [number, number, number]) {
      lightDirection = Vec3Math.normalize(direction as Vec3, 'Light direction');
    },
    setShadowDistance(distance: number) {
      if (Number.isFinite(distance) && distance > 0.5) shadowDistance = distance;
    },
    resize: (width: number, height: number) => graphics.resize({ width, height }),
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
