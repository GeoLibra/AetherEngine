import { describe, expect, test } from 'vitest';
import {
  App,
  BaselineRenderDiagnosticsResource,
  CameraRenderSource,
  DirectionalLightSource,
  HeadlessRunner,
  NullDevice,
  NullSurface,
  MaterialAssetType,
  MeshAssetType,
  MeshRenderSource,
  WorldTransform,
  createAssetHandle,
  createBaselineRenderingPlugin,
  createBoxMeshData,
  createStandardLitMaterial,
  type BrowserGraphicsSession,
  type DirectionalLightSourceView,
  type Plugin
} from '../../src';
import { cookEnvironmentPanorama, DEFAULT_COOK_RECIPES } from '../../tools/asset-cook/environment';
import { createConstantHdrFixture } from '../../benchmark/environment-cook/fixtures';
import type { EnvironmentAsset } from '../../src/assets/environment';

describe('baseline rendering: zero lights and zero meshes', () => {
  test('renders scene successfully with zero directional lights', async () => {
    const { graphics } = fixture();
    const mesh = createBoxMeshData();
    const material = createStandardLitMaterial({ baseColor: [0.2, 0.4, 0.8, 1] });
    const meshHandle = createAssetHandle(MeshAssetType, 'test.mesh.box');
    const materialHandle = createAssetHandle(MaterialAssetType, 'test.material.standard-lit');

    const scene: Plugin = {
      id: 'test.zero-lights-scene',
      dependencies: ['aether.baseline-rendering'],
      build(builder) {
        builder.addSystem('Startup', {
          id: 'test.zero-lights.spawn',
          run(world) {
            world
              .spawn()
              .insert(WorldTransform, transform([0, 0, 0]))
              .insert(CameraRenderSource, cameraSource('main-camera'))
              .build();
            world
              .spawn()
              .insert(WorldTransform, transform([0, 0, -2]))
              .insert(MeshRenderSource, meshSource(meshHandle, materialHandle, mesh.bounds))
              .build();
            // Note: zero DirectionalLightSource entities spawned in this scene.
          }
        });
      }
    };

    const app = new App()
      .addPlugin(
        createBaselineRenderingPlugin({
          graphics,
          mesh: { handle: meshHandle, payloadVersion: 1, data: mesh },
          material: { handle: materialHandle, payloadVersion: 1, material }
        })
      )
      .addPlugin(scene);

    await app.startup();
    await app.run(new HeadlessRunner({ frames: 1 }));

    const diagnostics = app.getResource(BaselineRenderDiagnosticsResource);
    expect(diagnostics).toMatchObject({
      frame: 1,
      viewId: 'main',
      status: 'rendered',
      renderPasses: 2,
      indexedDrawCalls: 1,
      indexCount: 36
    });
    expect(graphics.device.queue.metrics().submitted).toBe(1);

    await app.destroy();
  });

  test('clears and presents successfully when zero visible meshes exist', async () => {
    const { graphics } = fixture();
    const mesh = createBoxMeshData();
    const material = createStandardLitMaterial({ baseColor: [0.2, 0.4, 0.8, 1] });
    const meshHandle = createAssetHandle(MeshAssetType, 'test.mesh.box');
    const materialHandle = createAssetHandle(MaterialAssetType, 'test.material.standard-lit');

    const scene: Plugin = {
      id: 'test.zero-meshes-scene',
      dependencies: ['aether.baseline-rendering'],
      build(builder) {
        builder.addSystem('Startup', {
          id: 'test.zero-meshes.spawn',
          run(world) {
            world
              .spawn()
              .insert(WorldTransform, transform([0, 0, 0]))
              .insert(CameraRenderSource, cameraSource('main-camera'))
              .build();
            world
              .spawn()
              .insert(DirectionalLightSource, {
                direction: [0, -1, 0],
                colorLinear: [1, 1, 1],
                illuminanceLux: 10_000,
                enabled: true,
                layerMask: 1,
                castsShadow: false
              })
              .build();
            // Note: zero MeshRenderSource entities spawned.
          }
        });
      }
    };

    const app = new App()
      .addPlugin(
        createBaselineRenderingPlugin({
          graphics,
          mesh: { handle: meshHandle, payloadVersion: 1, data: mesh },
          material: { handle: materialHandle, payloadVersion: 1, material }
        })
      )
      .addPlugin(scene);

    await app.startup();
    await app.run(new HeadlessRunner({ frames: 1 }));

    const diagnostics = app.getResource(BaselineRenderDiagnosticsResource);
    expect(diagnostics).toMatchObject({
      frame: 1,
      viewId: 'main',
      status: 'rendered',
      indexedDrawCalls: 0,
      indexCount: 0
    });
    expect(graphics.device.queue.metrics().submitted).toBe(1);

    await app.destroy();
  });

  test('passes EnvironmentAsset through validateOptions to preparation', async () => {
    const { graphics } = fixture();
    const mesh = createBoxMeshData();
    const material = createStandardLitMaterial({ baseColor: [0.8, 0.2, 0.1, 1] });
    const meshHandle = createAssetHandle(MeshAssetType, 'demo.mesh.box');
    const materialHandle = createAssetHandle(MaterialAssetType, 'demo.material.standard-lit');

    const fixtureHdr = createConstantHdrFixture(16, 8, [2.0, 1.5, 1.0]);
    const canonical = {
      width: fixtureHdr.width,
      height: fixtureHdr.height,
      pixels: fixtureHdr.data,
      metadata: { format: '32-bit_rle_rgbe' as const, rawHeaderBytes: 40 }
    };
    const cooked = cookEnvironmentPanorama(canonical, DEFAULT_COOK_RECIPES['smoke-v1']);

    const environment: EnvironmentAsset = {
      assetId: 'asset.smoke-env' as never,
      artifact: cooked.environmentArtifact,
      irradianceBytes: cooked.irradianceBlob,
      radianceBytes: cooked.radianceBlob,
      brdfLutArtifact: cooked.brdfLutArtifact,
      brdfLutBytes: cooked.brdfLutBlob
    } as unknown as EnvironmentAsset;

    const plugin = createBaselineRenderingPlugin({
      graphics,
      mesh: { handle: meshHandle, payloadVersion: 1, data: mesh },
      material: { handle: materialHandle, payloadVersion: 1, material },
      environment
    });

    const scene: Plugin = {
      id: 'test.env-passthrough-scene',
      dependencies: ['aether.baseline-rendering'],
      build(builder) {
        builder.addSystem('Startup', {
          id: 'test.env.spawn',
          run(world) {
            world
              .spawn()
              .insert(WorldTransform, transform([0, 0, 0]))
              .insert(CameraRenderSource, cameraSource('main-camera'))
              .build();
            world
              .spawn()
              .insert(WorldTransform, transform([0, 0, -2]))
              .insert(MeshRenderSource, meshSource(meshHandle, materialHandle, mesh.bounds))
              .build();
          }
        });
      }
    };

    const app = new App().addPlugin(plugin).addPlugin(scene);
    await app.startup();
    await app.run(new HeadlessRunner({ frames: 1 }));

    const diagnostics = app.getResource(BaselineRenderDiagnosticsResource);
    expect(diagnostics).toMatchObject({
      frame: 1,
      viewId: 'main',
      status: 'rendered',
      indexedDrawCalls: 1
    });

    await app.destroy();
  });

  test('maintains continuous frame submissions during dynamic light toggle without freezing', async () => {
    const { graphics } = fixture();
    const mesh = createBoxMeshData();
    const material = createStandardLitMaterial({ baseColor: [0.5, 0.5, 0.5, 1] });
    const meshHandle = createAssetHandle(MeshAssetType, 'test.mesh.box');
    const materialHandle = createAssetHandle(MaterialAssetType, 'test.material.standard-lit');

    const history: import('../../src').BaselineRenderDiagnostics[] = [];
    let updateCount = 0;

    const scene: Plugin = {
      id: 'test.toggle-scene',
      dependencies: ['aether.baseline-rendering'],
      build(builder) {
        builder.addSystem('Startup', {
          id: 'test.toggle.spawn',
          run(world) {
            world
              .spawn()
              .insert(WorldTransform, transform([0, 0, 0]))
              .insert(CameraRenderSource, cameraSource('main-camera'))
              .build();
            world
              .spawn()
              .insert(WorldTransform, transform([0, 0, -2]))
              .insert(MeshRenderSource, meshSource(meshHandle, materialHandle, mesh.bounds))
              .build();
            world
              .spawn()
              .insert(DirectionalLightSource, {
                direction: [0, -1, 0],
                colorLinear: [1, 1, 1],
                illuminanceLux: 12_000,
                enabled: true,
                layerMask: 1,
                castsShadow: false
              })
              .build();
          }
        });
        builder.addSystem('Update', {
          id: 'test.toggle.update-light',
          writes: [DirectionalLightSource],
          run(world) {
            updateCount++;
            // Frame 2: turn off sunlight (enabled: false)
            const shouldEnable = updateCount !== 2;
            const lights = [...world.query([DirectionalLightSource])];
            for (const [entity, lightSource] of lights) {
              const source = lightSource as DirectionalLightSourceView;
              if (source.enabled !== shouldEnable) {
                world.insertComponent(entity, DirectionalLightSource, {
                  ...source,
                  enabled: shouldEnable,
                  illuminanceLux: shouldEnable ? 12_000 : 0
                });
              }
            }
          }
        });
        builder.addSystem('PostRender', {
          id: 'test.toggle.record-history',
          reads: [BaselineRenderDiagnosticsResource],
          run(world) {
            const diag = world.getResource(BaselineRenderDiagnosticsResource);
            if (diag) history.push(diag);
          }
        });
      }
    };

    const app = new App()
      .addPlugin(
        createBaselineRenderingPlugin({
          graphics,
          mesh: { handle: meshHandle, payloadVersion: 1, data: mesh },
          material: { handle: materialHandle, payloadVersion: 1, material }
        })
      )
      .addPlugin(scene);

    await app.startup();

    // Runs 3 continuous frames: frame 1 (light on) -> frame 2 (light off) -> frame 3 (light on)
    await app.run(new HeadlessRunner({ frames: 3 }));

    expect(history).toHaveLength(3);
    expect(history[0]).toMatchObject({ frame: 1, status: 'rendered', indexedDrawCalls: 1 });
    expect(history[1]).toMatchObject({ frame: 2, status: 'rendered', indexedDrawCalls: 1 });
    expect(history[2]).toMatchObject({ frame: 3, status: 'rendered', indexedDrawCalls: 1 });
    expect(graphics.device.queue.metrics().submitted).toBe(3);

    await app.destroy();
  });
});

function fixture() {
  const device = new NullDevice();
  const surface = new NullSurface({ id: Symbol('baseline-zero-scene'), kind: 'offscreen' });
  surface.configure(
    device,
    {
      format: 'rgba8unorm',
      colorSpace: 'srgb',
      alphaMode: 'opaque',
      width: 4,
      height: 4,
      presentMode: 'fifo'
    },
    1
  );
  const graphics = {
    backend: 'webgpu',
    adapter: {} as never,
    device,
    surface,
    lost: new Promise(() => undefined),
    subscribe: () => () => true,
    resize: () => undefined,
    destroy: async () => undefined
  } satisfies BrowserGraphicsSession;
  return { graphics };
}

function cameraSource(historyKey: string) {
  return {
    projection: {
      kind: 'perspective' as const,
      near: 0.1,
      far: 100,
      verticalFovRadians: Math.PI / 3
    },
    viewportRect: { x: 0, y: 0, width: 1, height: 1 },
    layerMask: 1,
    depthMode: 'standard' as const,
    historyKey
  };
}

function meshSource(meshHandle: any, materialHandle: any, bounds: any) {
  return {
    mesh: { handle: meshHandle, payloadVersion: 1 },
    submesh: 0,
    materials: [{ slot: 0, handle: materialHandle, payloadVersion: 1 }],
    localBounds: bounds,
    visible: true,
    layerMask: 1
  };
}

function transform(translation: readonly [number, number, number]) {
  const matrix = [
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    translation[0],
    translation[1],
    translation[2],
    1
  ];
  return {
    matrix,
    previousMatrix: matrix,
    normalMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    worldVersion: 1,
    originCell: [0, 0, 0],
    determinantSign: 1
  };
}
