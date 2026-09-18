import { describe, expect, test } from 'vitest';
import {
  App,
  BaselineRenderDiagnosticsResource,
  CameraRenderSource,
  FeaturePolicyRuntimeResource,
  MaterialAssetType,
  MeshAssetType,
  MeshRenderSource,
  NullDevice,
  NullSurface,
  WorldTransform,
  createAssetHandle,
  createBaselineRenderingPlugin,
  createBoxMeshData,
  createFeaturePolicyPlugin,
  createStandardLitMaterial,
  type BrowserGraphicsSession,
  type Plugin
} from '../../src';
import {
  BuiltInFeature,
  BuiltInFeatureImplementation
} from '../../src/rendering/lighting';
import {
  createBaselineFeaturePolicyInput,
  resolveBaselineFeaturePolicy
} from '../../src/rendering/baseline/baseline-feature-policy';
import { BaselineStandardLitPreparation } from '../../src/rendering/baseline/baseline-preparation';

const TEST_ENVIRONMENT_LIGHTING = Object.freeze({
  intensity: 1.0,
  radianceTint: [1, 1, 1] as [number, number, number],
  diffuseIrradiance: [0.1, 0.1, 0.1] as [number, number, number]
});

describe('FeaturePolicy forward baseline dynamic reconfiguration', () => {
  test('dynamically updates FeaturePolicy at PreRender boundary via FeaturePolicyPlugin on same device', async () => {
    const { graphics, device } = createGraphicsFixture('webgpu', {
      features: { compute: 'native', 'storage-buffer': 'native' },
      queues: [{ role: 'graphics', status: 'native' }, { role: 'compute', status: 'native' }]
    });

    const mesh = createBoxMeshData();
    const material = createStandardLitMaterial({ baseColor: [0.8, 0.2, 0.1, 1] });
    const meshHandle = createAssetHandle(MeshAssetType, 'demo.mesh.box');
    const materialHandle = createAssetHandle(MaterialAssetType, 'demo.material.box');

    let preferFallback = false;

    const scene: Plugin = {
      id: 'test.scene',
      dependencies: ['aether.baseline-rendering'],
      build(builder) {
        builder.addSystem('Startup', {
          id: 'test.scene.spawn',
          run(world) {
            world
              .spawn()
              .insert(WorldTransform, transform([0, 0, 0]))
              .insert(CameraRenderSource, {
                projection: { kind: 'perspective', near: 0.1, far: 100, verticalFovRadians: 1 },
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
          }
        });
      }
    };

    let disposedCount = 0;
    let onPublicationLease: any;

    const getPolicyInput = () => {
      const base = createBaselineFeaturePolicyInput({ device, viewId: 'main' });
      const implementations = base.implementations.map((impl) => ({
        ...impl,
        dispose(prep: any) {
          disposedCount++;
          impl.dispose(prep);
        }
      }));
      if (preferFallback) {
        return {
          ...base,
          implementations,
          requests: [
            {
              ...base.requests[0]!,
              supportPreference: ['fallback', 'emulated', 'native'] as const
            }
          ]
        };
      }
      return { ...base, implementations };
    };

    const app = new App()
      .addPlugin(
        createFeaturePolicyPlugin({
          input: getPolicyInput,
          onPublication: (pub) => {
            onPublicationLease = pub.retirement;
          }
        })
      )
      .addPlugin(
        createBaselineRenderingPlugin({
          graphics,
          mesh: { handle: meshHandle, payloadVersion: 1, data: mesh },
          material: { handle: materialHandle, payloadVersion: 1, material }
        })
      )
      .addPlugin(scene);

    await app.startup();

    const policyRuntime = app.getResource(FeaturePolicyRuntimeResource);

    const dynamicRunner = {
      async run(context: { readonly stopRequested: boolean; frame(time: number): unknown }) {
        // Frame 1: renders with initial compute policy
        context.frame(0);
        expect(policyRuntime?.current).toBeDefined();
        expect(policyRuntime?.current?.snapshot.decisions.get(BuiltInFeature.LightListBuild)?.implementation).toBe(
          BuiltInFeatureImplementation.WebGpuComputeLightList
        );

        // Outside frame schedule: stage fallback policy on the exact same device
        preferFallback = true;
        policyRuntime?.sources.profileChanged();
        const stageResult = await policyRuntime?.stage(getPolicyInput());
        expect(stageResult?.status).toBe('prepared');

        // Frame 2: PreRender publishes staged policy; BaselineRenderingRuntime hot-reconfigures to CpuBoundedLightList
        context.frame(1 / 60);
        expect(policyRuntime?.current?.snapshot.decisions.get(BuiltInFeature.LightListBuild)?.implementation).toBe(
          BuiltInFeatureImplementation.CpuBoundedLightList
        );

        // Wait for background promise chain (dispose & retirement release)
        await new Promise((resolve) => setTimeout(resolve, 10));
        // Baseline released its lease, but onPublication still holds its independent lease:
        expect(disposedCount).toBe(0);

        // Once onPublication completes and releases its lease, the old policy is disposed:
        onPublicationLease?.release();
        expect(disposedCount).toBe(1);

        return { reason: 'completed', frames: 2 };
      },
      requestStop: () => undefined
    };

    await app.run(dynamicRunner);

    const diagnostics = app.getResource(BaselineRenderDiagnosticsResource);
    expect(diagnostics?.status).toBe('rendered');

    await app.destroy();
  });

  test('fails fast when policy deviceGeneration does not match device generation', () => {
    const { graphics, device } = createGraphicsFixture('webgpu');
    const { device: otherDevice } = createGraphicsFixture('webgpu');
    // Bump otherDevice generation
    (otherDevice as any).generation = 999;

    const mesh = createBoxMeshData();
    const material = createStandardLitMaterial({ baseColor: [0.8, 0.2, 0.1, 1] });
    const meshHandle = createAssetHandle(MeshAssetType, 'test.mesh');
    const matHandle = createAssetHandle(MaterialAssetType, 'test.mat');

    const mismatchedPolicy = resolveBaselineFeaturePolicy({ device: otherDevice, viewId: 'test-mismatch' });

    expect(() => {
      new BaselineStandardLitPreparation({
        graphics,
        viewId: 'test-mismatch',
        featurePolicy: mismatchedPolicy,
        environmentLighting: TEST_ENVIRONMENT_LIGHTING,
        mesh: { handle: meshHandle, payloadVersion: 1, data: mesh },
        material: { handle: matHandle, payloadVersion: 1, material }
      });
    }).toThrow(/FeaturePolicy deviceGeneration \(999\) does not match current device generation/);
  });

  test('no-op policy revision does not recreate BaselineStandardLitPreparation', async () => {
    const { graphics, device } = createGraphicsFixture('webgpu', {
      features: { compute: 'native', 'storage-buffer': 'native' },
      queues: [{ role: 'graphics', status: 'native' }, { role: 'compute', status: 'native' }]
    });

    const mesh = createBoxMeshData();
    const material = createStandardLitMaterial({ baseColor: [0.8, 0.2, 0.1, 1] });
    const meshHandle = createAssetHandle(MeshAssetType, 'demo.mesh.box');
    const materialHandle = createAssetHandle(MaterialAssetType, 'demo.material.box');

    let revision = 1;
    let disposedCount = 0;
    let onPublicationLease: any;

    const getPolicyInput = () => {
      const base = createBaselineFeaturePolicyInput({ device, viewId: 'main' });
      const implementations = base.implementations.map((impl) => ({
        ...impl,
        dispose(prep: any) {
          disposedCount++;
          impl.dispose(prep);
        }
      }));
      return {
        ...base,
        implementations,
        revision
      };
    };

    const app = new App()
      .addPlugin(
        createFeaturePolicyPlugin({
          input: getPolicyInput,
          onPublication: (pub) => {
            onPublicationLease = pub.retirement;
          }
        })
      )
      .addPlugin(
        createBaselineRenderingPlugin({
          graphics,
          mesh: { handle: meshHandle, payloadVersion: 1, data: mesh },
          material: { handle: materialHandle, payloadVersion: 1, material }
        })
      );

    await app.startup();
    const policyRuntime = app.getResource(FeaturePolicyRuntimeResource);

    // Frame 1
    const runner = {
      async run(context: { readonly stopRequested: boolean; frame(time: number): unknown }) {
        context.frame(0);
        expect(policyRuntime?.current?.snapshot.revision).toBe(1);

        // Stage revision 2 with the same decisions & same shader key
        revision = 2;
        policyRuntime?.sources.registryChanged();
        const stageResult = await policyRuntime?.stage(getPolicyInput());
        expect(stageResult?.status).toBe('prepared');

        // Frame 2
        context.frame(1 / 60);
        expect(policyRuntime?.current?.snapshot.revision).toBe(2);
        await new Promise((resolve) => setTimeout(resolve, 10));
        // Baseline released its lease on no-op revision, but onPublication still holds its lease:
        expect(disposedCount).toBe(0);

        // When onPublication releases its lease, policy is disposed:
        onPublicationLease?.release();
        expect(disposedCount).toBe(1);

        return { reason: 'completed', frames: 2 };
      },
      requestStop: () => undefined
    };

    await app.run(runner);
    await app.destroy();
  });
});

function createGraphicsFixture(
  backend: 'webgpu' | 'webgl2',
  capabilitiesOverride?: {
    features?: Record<string, 'native' | 'emulated' | 'unsupported'>;
    queues?: Array<{ role: 'graphics' | 'compute' | 'transfer'; status: 'native' | 'emulated' | 'unsupported' }>;
    limits?: Record<string, number>;
    formats?: Map<string, any>;
  }
) {
  const baseDevice = new NullDevice();
  const featureEntries = capabilitiesOverride?.features
    ? Object.entries(capabilitiesOverride.features).map(([f, s]) => [f, { status: s }] as const)
    : [];
  const device =
    capabilitiesOverride === undefined
      ? baseDevice
      : new NullDevice({
          capabilities: {
            ...baseDevice.capabilities,
            features: new Map([...baseDevice.capabilities.features, ...featureEntries] as any),
            queues: (capabilitiesOverride.queues ?? baseDevice.capabilities.queues) as any,
            limits: { ...baseDevice.capabilities.limits, ...(capabilitiesOverride.limits ?? {}) },
            formats: capabilitiesOverride.formats ?? baseDevice.capabilities.formats
          }
        });

  const surface = new NullSurface({ id: Symbol(backend), kind: 'offscreen' });
  surface.configure(
    device,
    { format: 'rgba8unorm', colorSpace: 'srgb', alphaMode: 'opaque', width: 4, height: 4, presentMode: 'fifo' },
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

  return { graphics, device, surface };
}

function transform(translation: readonly [number, number, number]) {
  const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, translation[0], translation[1], translation[2], 1];
  return {
    matrix,
    previousMatrix: matrix,
    normalMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    worldVersion: 1,
    originCell: [0, 0, 0],
    determinantSign: 1
  };
}
