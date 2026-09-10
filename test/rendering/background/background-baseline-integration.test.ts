import { describe, expect, test } from 'vitest';
import {
  App,
  BaselineRenderDiagnosticsResource,
  CameraRenderSource,
  DirectionalLightSource,
  HeadlessRunner,
  MaterialAssetType,
  MeshAssetType,
  MeshRenderSource,
  NullDevice,
  NullSurface,
  WorldTransform,
  createAssetHandle,
  createBaselineRenderingPlugin,
  createBoxMeshData,
  createStandardLitMaterial,
  type BrowserGraphicsSession,
  type EnvironmentAsset,
  type Plugin
} from '../../../src';
import {
  cookEnvironmentPanorama,
  DEFAULT_COOK_RECIPES
} from '../../../tools/asset-cook/environment';
import { createConstantHdrFixture } from '../../../benchmark/environment-cook/fixtures';

describe('background baseline integration', () => {
  test('renders baseline scene with merged solid background', async () => {
    const { graphics } = fixture();
    const mesh = createBoxMeshData();
    const material = createStandardLitMaterial({ baseColor: [0.8, 0.2, 0.1, 1] });
    const meshHandle = createAssetHandle(MeshAssetType, 'demo.mesh.box');
    const materialHandle = createAssetHandle(MaterialAssetType, 'demo.material.standard-lit');

    const app = new App()
      .addPlugin(
        createBaselineRenderingPlugin({
          graphics,
          mesh: { handle: meshHandle, payloadVersion: 1, data: mesh },
          material: { handle: materialHandle, payloadVersion: 1, material },
          background: {
            kind: 'solid',
            colorLinear: [0.1, 0.2, 0.3]
          }
        })
      )
      .addPlugin(createScenePlugin(meshHandle, materialHandle, mesh.bounds));

    await app.startup();
    await app.run(new HeadlessRunner({ frames: 1 }));

    const diagnostics = app.getResource(BaselineRenderDiagnosticsResource);
    expect(diagnostics).toMatchObject({
      status: 'rendered',
      renderPasses: 2, // 1 fused (background + opaque) + 1 post-color
      indexedDrawCalls: 1
    });

    await app.destroy();
  });

  test('renders baseline scene with merged environment background (radiance-level-zero)', async () => {
    const { graphics } = fixture();
    const mesh = createBoxMeshData();
    const material = createStandardLitMaterial({ baseColor: [0.2, 0.5, 0.8, 1] });
    const meshHandle = createAssetHandle(MeshAssetType, 'demo.mesh.box');
    const materialHandle = createAssetHandle(MaterialAssetType, 'demo.material.standard-lit');

    const fixtureHdr = createConstantHdrFixture(16, 8, [1.5, 1.2, 0.9]);
    const cooked = cookEnvironmentPanorama(
      {
        width: fixtureHdr.width,
        height: fixtureHdr.height,
        pixels: fixtureHdr.data,
        metadata: { format: '32-bit_rle_rgbe', rawHeaderBytes: 40 }
      },
      DEFAULT_COOK_RECIPES['smoke-v1']
    );

    const environment: EnvironmentAsset = {
      assetId: 'asset.env-test' as any,
      artifact: cooked.environmentArtifact,
      irradianceBytes: cooked.irradianceBlob,
      radianceBytes: cooked.radianceBlob,
      brdfLutArtifact: cooked.brdfLutArtifact,
      brdfLutBytes: cooked.brdfLutBlob
    } as unknown as EnvironmentAsset;

    const app = new App()
      .addPlugin(
        createBaselineRenderingPlugin({
          graphics,
          mesh: { handle: meshHandle, payloadVersion: 1, data: mesh },
          material: { handle: materialHandle, payloadVersion: 1, material },
          environment,
          background: {
            kind: 'environment',
            source: 'view-environment',
            representation: 'radiance-level-zero',
            multiplier: 1.5
          }
        })
      )
      .addPlugin(createScenePlugin(meshHandle, materialHandle, mesh.bounds));

    await app.startup();
    await app.run(new HeadlessRunner({ frames: 1 }));

    const diagnostics = app.getResource(BaselineRenderDiagnosticsResource);
    expect(diagnostics).toMatchObject({
      status: 'rendered',
      renderPasses: 2, // 1 fused (background + opaque) + 1 post-color
      indexedDrawCalls: 1
    });

    await app.destroy();
  });

  test('supports explicit forceSeparatePasses option and renders cleanly', async () => {
    const { graphics } = fixture();
    const mesh = createBoxMeshData();
    const material = createStandardLitMaterial({ baseColor: [0.3, 0.3, 0.3, 1] });
    const meshHandle = createAssetHandle(MeshAssetType, 'demo.mesh.box');
    const materialHandle = createAssetHandle(MaterialAssetType, 'demo.material.standard-lit');

    const app = new App()
      .addPlugin(
        createBaselineRenderingPlugin({
          graphics,
          mesh: { handle: meshHandle, payloadVersion: 1, data: mesh },
          material: { handle: materialHandle, payloadVersion: 1, material },
          background: {
            kind: 'solid',
            colorLinear: [0.05, 0.05, 0.05]
          },
          forceSeparatePasses: true
        })
      )
      .addPlugin(createScenePlugin(meshHandle, materialHandle, mesh.bounds));

    await app.startup();
    await app.run(new HeadlessRunner({ frames: 1 }));

    const diagnostics = app.getResource(BaselineRenderDiagnosticsResource);
    expect(diagnostics).toMatchObject({
      status: 'rendered',
      renderPasses: 3, // 1 background + 1 opaque + 1 post-color
      indexedDrawCalls: 1
    });

    await app.destroy();
  });

  test('skips background when background kind is none and runs opaque directly', async () => {
    const { graphics } = fixture();
    const mesh = createBoxMeshData();
    const material = createStandardLitMaterial({ baseColor: [0.5, 0.5, 0.5, 1] });
    const meshHandle = createAssetHandle(MeshAssetType, 'demo.mesh.box');
    const materialHandle = createAssetHandle(MaterialAssetType, 'demo.material.standard-lit');

    const app = new App()
      .addPlugin(
        createBaselineRenderingPlugin({
          graphics,
          mesh: { handle: meshHandle, payloadVersion: 1, data: mesh },
          material: { handle: materialHandle, payloadVersion: 1, material },
          background: { kind: 'none' }
        })
      )
      .addPlugin(createScenePlugin(meshHandle, materialHandle, mesh.bounds));

    await app.startup();
    await app.run(new HeadlessRunner({ frames: 1 }));

    const diagnostics = app.getResource(BaselineRenderDiagnosticsResource);
    expect(diagnostics).toMatchObject({
      status: 'rendered',
      renderPasses: 2, // opaque + post-color (no background pass)
      indexedDrawCalls: 1
    });

    await app.destroy();
  });

  test('renders background-only scene with no mesh or material options (merged pass)', async () => {
    const { graphics } = fixture();
    const app = new App()
      .addPlugin(
        createBaselineRenderingPlugin({
          graphics,
          background: {
            kind: 'solid',
            colorLinear: [0.2, 0.4, 0.6]
          }
        })
      )
      .addPlugin(createCameraOnlyScenePlugin());

    await app.startup();
    await app.run(new HeadlessRunner({ frames: 1 }));

    const diagnostics = app.getResource(BaselineRenderDiagnosticsResource);
    expect(diagnostics).toMatchObject({
      status: 'rendered',
      renderPasses: 2, // 1 merged background/opaque + 1 post-color
      indexedDrawCalls: 0
    });

    await app.destroy();
  });

  test('renders background-only scene with forceSeparatePasses: true (separate passes)', async () => {
    const { graphics } = fixture();
    const app = new App()
      .addPlugin(
        createBaselineRenderingPlugin({
          graphics,
          background: {
            kind: 'solid',
            colorLinear: [0.2, 0.4, 0.6]
          },
          forceSeparatePasses: true
        })
      )
      .addPlugin(createCameraOnlyScenePlugin());

    await app.startup();
    await app.run(new HeadlessRunner({ frames: 1 }));

    const diagnostics = app.getResource(BaselineRenderDiagnosticsResource);
    expect(diagnostics).toMatchObject({
      status: 'rendered',
      renderPasses: 3, // 1 background + 1 opaque + 1 post-color
      indexedDrawCalls: 0
    });

    await app.destroy();
  });
});

function createCameraOnlyScenePlugin(): Plugin {
  return {
    id: 'test.camera-only-scene',
    dependencies: ['aether.baseline-rendering'],
    build(builder) {
      builder.addSystem('Startup', {
        id: 'test.camera-only-scene.spawn',
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
              historyKey: 'main-camera'
            })
            .build();
        }
      });
    }
  };
}

function createScenePlugin(
  meshHandle: ReturnType<typeof createAssetHandle>,
  materialHandle: ReturnType<typeof createAssetHandle>,
  bounds: any
): Plugin {
  return {
    id: 'test.integration-scene',
    dependencies: ['aether.baseline-rendering'],
    build(builder) {
      builder.addSystem('Startup', {
        id: 'test.integration-scene.spawn',
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
              historyKey: 'main-camera'
            })
            .build();
          world
            .spawn()
            .insert(WorldTransform, transform([0, 0, -2]))
            .insert(MeshRenderSource, {
              mesh: { handle: meshHandle, payloadVersion: 1 },
              submesh: 0,
              materials: [{ slot: 0, handle: materialHandle, payloadVersion: 1 }],
              localBounds: bounds,
              visible: true,
              layerMask: 1
            })
            .build();
          world
            .spawn()
            .insert(DirectionalLightSource, {
              direction: [0, -1, -1],
              colorLinear: [1, 1, 1],
              illuminanceLux: 10_000,
              enabled: true,
              layerMask: 1,
              castsShadow: false
            })
            .build();
        }
      });
    }
  };
}

function fixture() {
  const device = new NullDevice();
  const surface = new NullSurface({ id: Symbol('baseline-bg-test'), kind: 'offscreen' });
  surface.configure(
    device,
    {
      format: 'rgba8unorm',
      colorSpace: 'srgb',
      alphaMode: 'opaque',
      width: 8,
      height: 8,
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
