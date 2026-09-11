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
  BaselineBackgroundControlResource,
  BaselineBackgroundService,
  type BrowserGraphicsSession,
  type Plugin,
  type RunnerContext
} from '../../src';
import { cookEnvironmentPanorama, DEFAULT_COOK_RECIPES } from '../../tools/asset-cook/environment';
import { createConstantHdrFixture } from '../../benchmark/environment-cook/fixtures';
import type { EnvironmentAsset } from '../../src/assets/environment';

describe('baseline rendering plugin', () => {
  test('renders one MainWorld-authored standard-lit indexed box through Null RHI', async () => {
    const { graphics } = fixture(true);
    const mesh = createBoxMeshData();
    const material = createStandardLitMaterial({ baseColor: [0.8, 0.2, 0.1, 1] });
    const meshHandle = createAssetHandle(MeshAssetType, 'demo.mesh.box');
    const materialHandle = createAssetHandle(MaterialAssetType, 'demo.material.standard-lit');
    const scene: Plugin = {
      id: 'test.baseline-scene',
      dependencies: ['aether.baseline-rendering'],
      build(builder) {
        builder.addSystem('Startup', {
          id: 'test.baseline-scene.spawn',
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
                historyKey: 'main-history'
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
                direction: [0, -1, -1],
                colorLinear: [1, 1, 1],
                illuminanceLux: 10_000,
                enabled: true,
                layerMask: 1,
                castsShadow: true
              })
              .build();
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

    expect(app.getResource(BaselineRenderDiagnosticsResource)).toMatchObject({
      status: 'rendered',
      renderPasses: 6,
      indexedDrawCalls: 5,
      indexCount: 180
    });
    expect(graphics.device.queue.metrics().submitted).toBe(1);
    await app.destroy();
  });

  test('registers its frame systems and publishes typed missing-scene diagnostics', async () => {
    const { graphics } = fixture(true);
    const app = new App().addPlugin(createBaselineRenderingPlugin({ graphics }));

    await app.startup();
    expect(app.getResource(BaselineRenderDiagnosticsResource)).toMatchObject({ status: 'idle' });
    await app.run(new HeadlessRunner({ frames: 1 }));
    expect(app.getResource(BaselineRenderDiagnosticsResource)).toMatchObject({
      status: 'skipped',
      reason: 'missing-resource',
      viewId: 'main'
    });
    await app.destroy();
  });

  test('publishes surface-suspended without acquiring or submitting a zero-extent surface', async () => {
    const { graphics } = fixture(true);
    const app = new App().addPlugin(createBaselineRenderingPlugin({ graphics }));
    await app.startup();
    graphics.surface.configure(
      graphics.device,
      {
        format: 'rgba8unorm',
        colorSpace: 'srgb',
        alphaMode: 'opaque',
        width: 0,
        height: 4,
        presentMode: 'fifo'
      },
      2
    );

    await app.run(new HeadlessRunner({ frames: 1 }));

    expect(app.getResource(BaselineRenderDiagnosticsResource)).toMatchObject({
      status: 'skipped',
      reason: 'surface-suspended'
    });
    expect(graphics.surface.acquiredFrameCount).toBe(0);
    expect(graphics.device.queue.metrics().submitted).toBe(0);
    await app.destroy();
  });

  test('rolls back transactional registrations when startup graphics validation fails', async () => {
    const { graphics } = fixture(false);
    const app = new App().addPlugin(createBaselineRenderingPlugin({ graphics }));

    await expect(app.startup()).rejects.toThrow(/configured graphics surface/i);
    expect(app.state).toBe('failed');
    expect(app.getResource(BaselineRenderDiagnosticsResource)).toBeUndefined();
  });

  test('unsubscribes and disposes in reverse plugin shutdown order', async () => {
    const events: string[] = [];
    const { graphics } = fixture(true, events);
    const consumer: Plugin = {
      id: 'test.baseline-consumer',
      dependencies: ['aether.baseline-rendering'],
      build() {},
      shutdown() {
        events.push('consumer');
      }
    };
    const app = new App()
      .addPlugin(createBaselineRenderingPlugin({ graphics }))
      .addPlugin(consumer);

    await app.startup();
    await app.destroy();
    expect(events).toEqual(['consumer', 'baseline-unsubscribe']);
  });

  test('rejects empty public identities before mutating App state', () => {
    const { graphics } = fixture(true);
    expect(() => createBaselineRenderingPlugin({ graphics, viewId: ' ' })).toThrow(/viewId/i);
    expect(() => createBaselineRenderingPlugin({ graphics, featurePolicyKey: '' })).toThrow(
      /featurePolicyKey/i
    );
    expect(() =>
      createBaselineRenderingPlugin({
        graphics,
        mesh: {
          handle: createAssetHandle(MeshAssetType, 'invalid.unpaired.mesh'),
          payloadVersion: 1,
          data: createBoxMeshData()
        }
      })
    ).toThrow(/provided together/i);
  });

  test('accepts and renders with cooked EnvironmentAsset', async () => {
    const { graphics } = fixture(true);
    const mesh = createBoxMeshData();
    const material = createStandardLitMaterial({ baseColor: [0.8, 0.2, 0.1, 1] });
    const meshHandle = createAssetHandle(MeshAssetType, 'demo.mesh.box');
    const materialHandle = createAssetHandle(MaterialAssetType, 'demo.material.standard-lit');

    const fixtureHdr = createConstantHdrFixture(16, 8, [2.0, 1.5, 1.0]);
    const canonical = {
      width: fixtureHdr.width,
      height: fixtureHdr.height,
      pixels: fixtureHdr.data,
      metadata: { format: '32-bit_rle_rgbe', rawHeaderBytes: 40 }
    };
    const cooked = cookEnvironmentPanorama(canonical, DEFAULT_COOK_RECIPES['smoke-v1']);

    const environment: EnvironmentAsset = {
      assetId: 'asset.smoke-env' as any,
      artifact: cooked.environmentArtifact,
      irradianceBytes: cooked.irradianceBlob,
      radianceBytes: cooked.radianceBlob,
      brdfLutArtifact: cooked.brdfLutArtifact,
      brdfLutBytes: cooked.brdfLutBlob
    } as unknown as EnvironmentAsset;

    const scene: Plugin = {
      id: 'test.baseline-env-scene',
      dependencies: ['aether.baseline-rendering'],
      build(builder) {
        builder.addSystem('Startup', {
          id: 'test.baseline-env-scene.spawn',
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
                historyKey: 'main-history'
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

    const app = new App()
      .addPlugin(
        createBaselineRenderingPlugin({
          graphics,
          mesh: { handle: meshHandle, payloadVersion: 1, data: mesh },
          material: { handle: materialHandle, payloadVersion: 1, material },
          environment
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
      indexedDrawCalls: 1
    });

    await app.destroy();
  });

  test('allows updating background configuration at runtime via typed resource, service, and plugin', async () => {
    const { graphics } = fixture(true);
    const renderingPlugin = createBaselineRenderingPlugin({
      graphics,
      background: { kind: 'solid', colorLinear: [0, 0, 0] }
    });

    expect(typeof renderingPlugin.setBackground).toBe('function');
    expect(renderingPlugin.backgroundControl).toBeDefined();

    const app = new App().addPlugin(renderingPlugin);
    await app.startup();

    // Verify resource and service registration
    const resourceControl = app.getResource(BaselineBackgroundControlResource);
    const serviceControl = app.getService(BaselineBackgroundService);
    expect(resourceControl).toBe(renderingPlugin.backgroundControl);
    expect(serviceControl).toBe(renderingPlugin.backgroundControl);

    const runner = {
      async run(context: RunnerContext) {
        context.frame(0);
        // 1. Update via plugin ergonomic method
        renderingPlugin.setBackground({ kind: 'solid', colorLinear: [0.5, 0.5, 0.5] });
        expect(resourceControl?.isDirty).toBe(true);
        expect(resourceControl?.current).toEqual({ kind: 'solid', colorLinear: [0.5, 0.5, 0.5] });

        context.frame(1 / 60);
        expect(resourceControl?.isDirty).toBe(false);

        // 2. Update via service
        serviceControl.setBackground({ kind: 'none' });
        expect(resourceControl?.isDirty).toBe(true);

        context.frame(2 / 60);
        expect(resourceControl?.isDirty).toBe(false);

        // 3. Clear via resource
        resourceControl?.clearBackground();
        expect(resourceControl?.isDirty).toBe(true);
        expect(resourceControl?.current).toBeUndefined();

        context.frame(3 / 60);
        expect(resourceControl?.isDirty).toBe(false);

        return { reason: 'completed', frames: 4 };
      },
      requestStop() {}
    };

    const exit = await app.run(runner);
    expect(exit.frames).toBe(4);

    // Validates invalid background and throws error fail-fast
    expect(() => renderingPlugin.setBackground({ kind: 'invalid' } as any)).toThrow();
    expect(() => resourceControl?.setBackground({ kind: 'invalid' } as any)).toThrow();

    await app.destroy();
  });
});

function fixture(configured: boolean, events: string[] = []) {
  const device = new NullDevice();
  const surface = new NullSurface({ id: Symbol('baseline-plugin'), kind: 'offscreen' });
  if (configured) {
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
  }
  const graphics = {
    backend: 'webgpu',
    adapter: {} as never,
    device,
    surface,
    lost: new Promise(() => undefined),
    subscribe: () => () => {
      events.push('baseline-unsubscribe');
      return true;
    },
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
