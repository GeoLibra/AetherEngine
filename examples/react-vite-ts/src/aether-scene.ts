import {
  App,
  BrowserRunner,
  CameraRenderSource,
  DirectionalLightSource,
  MaterialAssetType,
  MeshAssetType,
  MeshRenderSource,
  WorldTransform,
  createAssetHandle,
  createBaselineRenderingPlugin,
  createBoxMeshData,
  createBrowserGraphics,
  createStandardLitMaterial,
  definePlugin,
  type BrowserGraphicsSession
} from '@aether/engine';

export interface MountedAetherScene {
  readonly backend: BrowserGraphicsSession['backend'];
  destroy(): Promise<void>;
}

/** Mounts the public baseline renderer and one MainWorld-authored scene on a canvas. */
export async function mountAetherScene(canvas: HTMLCanvasElement): Promise<MountedAetherScene> {
  const size = physicalSize(canvas);
  const graphics = await createBrowserGraphics({
    canvas,
    preference: ['webgpu', 'webgl2'],
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
