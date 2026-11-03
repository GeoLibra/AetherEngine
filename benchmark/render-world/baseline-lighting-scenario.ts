import {
  CameraRenderSource,
  DirectionalLightSource,
  PointLightSource,
  SpotLightSource,
  MeshRenderSource,
  WorldTransform,
  World,
  NullDevice,
  NullSurface,
  MeshAssetType,
  MaterialAssetType,
  createAssetHandle,
  createBoxMeshData,
  createStandardLitMaterial,
  Mat4,
  type BrowserGraphicsSession
} from '../../src';
import { BaselineRenderingRuntime } from '../../src/rendering/baseline/baseline-rendering-runtime';
import { validateOptions } from '../../src/rendering/baseline/baseline-options';

/** Creates a deterministic Null-RHI lighting workload with off-camera shadow casters. */
export function baselineLightingFixture(
  options: {
    far?: number | 'infinite';
    depthMode?: 'standard' | 'reverse';
    clustered?: boolean;
    light?: 'spot' | 'point';
    cameraLayerMask?: number;
    offscreenCasters?: number;
  } = {}
) {
  const base = new NullDevice();
  const device = options.clustered
    ? new NullDevice({
        capabilities: {
          ...base.capabilities,
          features: new Map([
            ...base.capabilities.features,
            ['compute', { status: 'native' as const }],
            ['storage-buffer', { status: 'native' as const }]
          ]),
          queues: [
            { role: 'graphics', status: 'native' },
            { role: 'compute', status: 'native' }
          ]
        }
      })
    : base;
  const surface = new NullSurface({ id: Symbol('baseline-test'), kind: 'offscreen' });
  surface.configure(
    device,
    {
      format: 'rgba8unorm',
      colorSpace: 'srgb',
      alphaMode: 'opaque',
      width: 64,
      height: 64,
      presentMode: 'fifo'
    },
    1
  );
  const graphics: BrowserGraphicsSession = {
    backend: 'webgpu',
    adapter: {} as never,
    device,
    surface,
    lost: new Promise(() => undefined),
    subscribe: () => () => true,
    resize: () => undefined,
    destroy: async () => undefined
  };
  const mesh = createBoxMeshData();
  const meshHandle = createAssetHandle(MeshAssetType, 'test.mesh');
  const materialHandle = createAssetHandle(MaterialAssetType, 'test.material');
  const material = createStandardLitMaterial({ baseColor: [1, 1, 1, 1] });
  const runtime = new BaselineRenderingRuntime(
    validateOptions({
      graphics,
      mesh: { handle: meshHandle, payloadVersion: 1, data: mesh },
      material: { handle: materialHandle, payloadVersion: 1, material }
    })
  );
  const world = new World();
  world
    .registerComponent(WorldTransform)
    .registerComponent(CameraRenderSource)
    .registerComponent(MeshRenderSource)
    .registerComponent(DirectionalLightSource)
    .registerComponent(PointLightSource)
    .registerComponent(SpotLightSource);
  world
    .spawn()
    .insert(WorldTransform, transform(0, 0, 0))
    .insert(CameraRenderSource, {
      projection: {
        kind: 'perspective',
        near: 0.1,
        far: options.far ?? 20,
        verticalFovRadians: Math.PI / 3
      },
      viewportRect: { x: 0, y: 0, width: 1, height: 1 },
      layerMask: options.cameraLayerMask ?? 1,
      depthMode: options.depthMode ?? 'standard',
      historyKey: 'test'
    })
    .build();
  const addMesh = (x: number, y: number, z: number, layerMask = 1, visible = true) =>
    world
      .spawn()
      .insert(WorldTransform, transform(x, y, z))
      .insert(MeshRenderSource, {
        mesh: { handle: meshHandle, payloadVersion: 1 },
        submesh: 0,
        materials: [{ slot: 0, handle: materialHandle, payloadVersion: 1 }],
        localBounds: mesh.bounds,
        visible,
        layerMask
      })
      .build();
  addMesh(0, 0, -4);
  for (let i = 0; i < (options.offscreenCasters ?? 1); i++) addMesh(3, 0, -2);
  if (options.light !== undefined) {
    const common = {
      position: [3, 0, 0] as const,
      colorLinear: [1, 1, 1] as const,
      luminousIntensityCandela: 100,
      range: 20,
      enabled: true,
      layerMask: 1,
      castsShadow: true
    };
    if (options.light === 'spot')
      world
        .spawn()
        .insert(SpotLightSource, {
          ...common,
          direction: [0, 0, -1],
          innerRadians: 0.8,
          outerRadians: 1
        })
        .build();
    else world.spawn().insert(PointLightSource, common).build();
  }
  runtime.initializePreparation();
  return { runtime, world, addMesh, device };
}

function transform(x: number, y: number, z: number) {
  const matrix = Mat4.fromTranslation([x, y, z]);
  return {
    matrix,
    previousMatrix: matrix,
    normalMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    determinantSign: 1,
    worldVersion: 1,
    originCell: [0, 0, 0]
  };
}
