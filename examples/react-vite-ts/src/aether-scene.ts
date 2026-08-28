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
  WorldTransform,
  createAssetHandle,
  createBaselineRenderingPlugin,
  createBoxMeshData,
  createBrowserGraphics,
  createStandardLitMaterial,
  definePlugin,
  BaselineRenderDiagnosticsResource,
  type BaselineRenderDiagnostics,
  type BrowserGraphicsSession,
  type WorldTransformView
} from '@aether/engine';

export interface MountedAetherScene {
  readonly backend: BrowserGraphicsSession['backend'];
  diagnostics(): BaselineRenderDiagnostics | undefined;
  nativeMetrics(): unknown;
  /** Overrides automatic rotation with a deterministic YXZ angle in radians. */
  setRotation(angleRadians: number): void;
  resize(width: number, height: number): void;
  destroy(): Promise<void>;
}

export interface AetherSceneOptions {
  readonly preference?: readonly BrowserGraphicsSession['backend'][];
  /** Enables frame-time rotation; defaults to true and is disabled only for deterministic capture. */
  readonly animate?: boolean;
}

/** Mounts the public baseline renderer and one MainWorld-authored scene on a canvas. */
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
  const app = new App()
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
        dependencies: ['aether.baseline-rendering'],
        build(builder) {
          builder.addSystem('Startup', {
            id: 'example.standard-lit-scene.spawn',
            run(world) {
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
              world
                .spawn()
                .insert(WorldTransform, transform([0, 0, -2]))
                .insert(MeshRenderSource, {
                  mesh: { handle: meshHandle, payloadVersion: 1 },
                  submesh: 0,
                  materials: [{ slot: 0, handle: materialHandle, payloadVersion: 1 }],
                  localBounds: mesh.bounds,
                  visible: true,
                  layerMask: 1
                })
                .build();
              world
                .spawn()
                .insert(DirectionalLightSource, {
                  direction: [-0.5, -1, -0.75],
                  colorLinear: [1, 0.95, 0.88],
                  illuminanceLux: 12_000,
                  enabled: true,
                  layerMask: 1,
                  castsShadow: false
                })
                .build();
            }
          });
          builder.addSystem('Update', {
            id: 'example.standard-lit-scene.rotate',
            reads: [FrameTimeResource, MeshRenderSource],
            writes: [WorldTransform],
            run(world) {
              const frameTime = world.getResource(FrameTimeResource);
              if (frameTime === undefined) {
                throw new Error('Rotating scene requires the frame-time resource.');
              }
              const angle = forcedRotation ?? frameTime.elapsed * 0.8;
              for (const [, worldTransform] of world.query([WorldTransform, MeshRenderSource])) {
                rotateWorldTransform(worldTransform, angle);
              }
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

function rotateWorldTransform(worldTransform: WorldTransformView, angleRadians: number): void {
  worldTransform.previousMatrix.set(worldTransform.matrix);
  const matrix = Mat4.fromTRS(
    [0, 0, -2],
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

function transform(translation: readonly [number, number, number]) {
  const [x, y, z] = translation;
  return {
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1],
    previousMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1],
    normalMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    worldVersion: 1,
    originCell: [0, 0, 0],
    determinantSign: 1
  };
}
