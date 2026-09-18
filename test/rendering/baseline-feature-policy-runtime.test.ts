import { describe, expect, test } from 'vitest';
import {
  App,
  BaselineRenderDiagnosticsResource,
  CameraRenderSource,
  DirectionalLightSource,
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
  prepareBaselineFeaturePolicy,
  resolveBaselineFeaturePolicy
} from '../../src/rendering/baseline/baseline-feature-policy';
import { BaselineStandardLitPreparation } from '../../src/rendering/baseline/baseline-preparation';
import { BaselineRenderer } from '../../src/rendering/baseline/baseline-renderer';

const TEST_ENVIRONMENT_LIGHTING = Object.freeze({
  intensity: 1.0,
  radianceTint: [1, 1, 1] as [number, number, number],
  diffuseIrradiance: [0.1, 0.1, 0.1] as [number, number, number]
});

describe('FeaturePolicy forward baseline rendering runtime integration', () => {
  test('executes WebGPU compute path with coordinator-published PreparedFeaturePolicy', async () => {
    const { graphics, device } = createGraphicsFixture('webgpu', {
      features: { compute: 'native', 'storage-buffer': 'native' },
      queues: [{ role: 'graphics', status: 'native' }, { role: 'compute', status: 'native' }]
    });

    const session = await prepareBaselineFeaturePolicy({ device, viewId: 'test-webgpu' });
    expect(session.policy.snapshot.decisions.get(BuiltInFeature.LightListBuild)?.implementation).toBe(
      BuiltInFeatureImplementation.WebGpuComputeLightList
    );

    const mesh = createBoxMeshData();
    const material = createStandardLitMaterial({ baseColor: [0.8, 0.2, 0.1, 1] });
    const meshHandle = createAssetHandle(MeshAssetType, 'test.mesh');
    const matHandle = createAssetHandle(MaterialAssetType, 'test.mat');

    const prep = new BaselineStandardLitPreparation({
      graphics,
      viewId: 'test-webgpu',
      featurePolicy: session.policy,
      environmentLighting: TEST_ENVIRONMENT_LIGHTING,
      mesh: { handle: meshHandle, payloadVersion: 1, data: mesh },
      material: { handle: matHandle, payloadVersion: 1, material }
    });

    const lightFrame = prep.createLightListFrame({
      viewLayerMask: 1,
      lights: [],
      receivers: []
    });
    expect(lightFrame.source).toBe('gpu-compute');

    const renderer = new BaselineRenderer({ graphics });
    const result = renderer.frame({
      status: 'ready',
      view: {
        id: 'test-webgpu',
        camera: 1 as any,
        surface: 'main',
        viewport: { x: 0, y: 0, width: 4, height: 4 },
        layerMask: 1,
        featurePolicyKey: session.policy.snapshot.hash,
        historyKey: 'test-webgpu-history'
      },
      packets: [],
      environment: prep.environmentFrame,
      lightList: lightFrame,
      shadowReceiver: prep.disabledShadowReceiver,
      postColor: prep.postColor,
      deviceGeneration: device.generation,
      surfaceGeneration: 1
    });

    expect(result.status).toBe('rendered');
    lightFrame.release();
    await prep.dispose();
    await session.dispose();
  });

  test('executes WebGL2 fragment MRT path with coordinator-published PreparedFeaturePolicy', async () => {
    const { graphics, device } = createGraphicsFixture('webgl2', {
      features: { compute: 'unsupported', 'storage-buffer': 'unsupported' },
      queues: [{ role: 'graphics', status: 'native' }],
      limits: { maxColorAttachments: 4, maxTextureDimension2D: 4096 },
      formats: new Map([
        [
          'rgba32uint',
          {
            sample: true,
            filter: false,
            render: true,
            blend: false,
            storage: false,
            copySrc: true,
            copyDst: true,
            sampleCounts: [1]
          }
        ]
      ])
    });

    const session = await prepareBaselineFeaturePolicy({ device, viewId: 'test-webgl' });
    expect(session.policy.snapshot.decisions.get(BuiltInFeature.LightListBuild)?.implementation).toBe(
      BuiltInFeatureImplementation.WebGlFragmentLightList
    );

    const mesh = createBoxMeshData();
    const material = createStandardLitMaterial({ baseColor: [0.8, 0.2, 0.1, 1] });
    const meshHandle = createAssetHandle(MeshAssetType, 'test.mesh');
    const matHandle = createAssetHandle(MaterialAssetType, 'test.mat');

    const prep = new BaselineStandardLitPreparation({
      graphics,
      viewId: 'test-webgl',
      featurePolicy: session.policy,
      environmentLighting: TEST_ENVIRONMENT_LIGHTING,
      mesh: { handle: meshHandle, payloadVersion: 1, data: mesh },
      material: { handle: matHandle, payloadVersion: 1, material }
    });

    const lightFrame = prep.createLightListFrame({
      viewLayerMask: 1,
      lights: [],
      receivers: []
    });
    expect(lightFrame.source).toBe('webgl-fragment');

    const renderer = new BaselineRenderer({ graphics });
    const result = renderer.frame({
      status: 'ready',
      view: {
        id: 'test-webgl',
        camera: 1 as any,
        surface: 'main',
        viewport: { x: 0, y: 0, width: 4, height: 4 },
        layerMask: 1,
        featurePolicyKey: session.policy.snapshot.hash,
        historyKey: 'test-webgl-history'
      },
      packets: [],
      environment: prep.environmentFrame,
      lightList: lightFrame,
      shadowReceiver: prep.disabledShadowReceiver,
      postColor: prep.postColor,
      deviceGeneration: device.generation,
      surfaceGeneration: 1
    });

    expect(result.status).toBe('rendered');
    lightFrame.release();
    await prep.dispose();
    await session.dispose();
  });

  test('executes CPU bounded fallback path when GPU compute and MRT are unsupported', async () => {
    const { graphics, device } = createGraphicsFixture('webgpu', {
      features: { compute: 'unsupported', 'storage-buffer': 'unsupported' },
      queues: [{ role: 'graphics', status: 'native' }]
    });

    const session = await prepareBaselineFeaturePolicy({ device, viewId: 'test-cpu' });
    expect(session.policy.snapshot.decisions.get(BuiltInFeature.LightListBuild)?.implementation).toBe(
      BuiltInFeatureImplementation.CpuBoundedLightList
    );

    const mesh = createBoxMeshData();
    const material = createStandardLitMaterial({ baseColor: [0.8, 0.2, 0.1, 1] });
    const meshHandle = createAssetHandle(MeshAssetType, 'test.mesh');
    const matHandle = createAssetHandle(MaterialAssetType, 'test.mat');

    const prep = new BaselineStandardLitPreparation({
      graphics,
      viewId: 'test-cpu',
      featurePolicy: session.policy,
      environmentLighting: TEST_ENVIRONMENT_LIGHTING,
      mesh: { handle: meshHandle, payloadVersion: 1, data: mesh },
      material: { handle: matHandle, payloadVersion: 1, material }
    });

    const lightFrame = prep.createLightListFrame({
      viewLayerMask: 1,
      lights: [
        {
          entity: 5 as any,
          payloadVersion: 1,
          kind: 'directional',
          direction: [0, -1, 0],
          colorLinear: [1, 1, 1],
          illuminanceLux: 1000,
          enabled: true,
          layerMask: 1,
          castsShadow: false
        }
      ],
      receivers: [
        {
          renderEntity: 2 as any,
          layerMask: 1,
          enabled: true,
          bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1 }
        }
      ]
    });

    if (lightFrame.source !== 'cpu-list') {
      throw new Error(`Expected cpu-list light frame, got ${lightFrame.source}`);
    }
    expect(lightFrame.backendTarget).toBe('webgpu');

    const renderer = new BaselineRenderer({ graphics });
    const result = renderer.frame({
      status: 'ready',
      view: {
        id: 'test-cpu',
        camera: 1 as any,
        surface: 'main',
        viewport: { x: 0, y: 0, width: 4, height: 4 },
        layerMask: 1,
        featurePolicyKey: session.policy.snapshot.hash,
        historyKey: 'test-cpu-history'
      },
      packets: [],
      environment: prep.environmentFrame,
      lightList: lightFrame,
      shadowReceiver: prep.disabledShadowReceiver,
      postColor: prep.postColor,
      deviceGeneration: device.generation,
      surfaceGeneration: 1
    });

    expect(result.status).toBe('rendered');
    lightFrame.release();
    await prep.dispose();
    await session.dispose();
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
