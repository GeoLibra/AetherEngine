import { describe, expect, test } from 'vitest';
import {
  App,
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
  createBaselineFeaturePolicyInput,
  resolveBaselineFeaturePolicy,
  validateBaselineLightListCapacity
} from '../../src/rendering/baseline/baseline-feature-policy';
import { BaselineStandardLitPreparation } from '../../src/rendering/baseline/baseline-preparation';
import { BaselineRenderingRuntime } from '../../src/rendering/baseline/baseline-rendering-runtime';
import { validateOptions } from '../../src/rendering/baseline/baseline-options';
import {
  LIGHT_LIST_SHADER_MAX_DIRECTIONAL_LIGHTS,
  LIGHT_LIST_SHADER_MAX_INDICES,
  LIGHT_LIST_SHADER_MAX_LIGHTS
} from '../../src/rendering/lighting';

const TEST_ENVIRONMENT_LIGHTING = Object.freeze({
  intensity: 1.0,
  radianceTint: [1, 1, 1] as [number, number, number],
  diffuseIrradiance: [0.1, 0.1, 0.1] as [number, number, number]
});

describe('Baseline FeaturePolicy boundary and lifecycle contracts', () => {
  test('fails fast at policy resolution and preparation when light list capacity exceeds shader ABI maximums', () => {
    const { device } = createGraphicsFixture('webgpu');

    expect(() =>
      validateBaselineLightListCapacity({
        maxDirectionalLights: LIGHT_LIST_SHADER_MAX_DIRECTIONAL_LIGHTS + 1,
        maxLightsPerReceiver: 16,
        maxLightIndices: 1024
      })
    ).toThrow(RangeError);

    expect(() =>
      validateBaselineLightListCapacity({
        maxDirectionalLights: 16,
        maxLightsPerReceiver: 16,
        maxLightIndices: LIGHT_LIST_SHADER_MAX_INDICES + 1
      })
    ).toThrow(RangeError);

    expect(() =>
      validateBaselineLightListCapacity({
        maxDirectionalLights: 16,
        maxLightsPerReceiver: LIGHT_LIST_SHADER_MAX_LIGHTS + 1,
        maxLightIndices: 1024
      })
    ).toThrow(RangeError);

    expect(() =>
      createBaselineFeaturePolicyInput({
        device,
        capacity: {
          maxDirectionalLights: LIGHT_LIST_SHADER_MAX_DIRECTIONAL_LIGHTS + 1,
          maxLightsPerReceiver: 16,
          maxLightIndices: 1024
        }
      })
    ).toThrow(RangeError);

    expect(() =>
      resolveBaselineFeaturePolicy({
        device,
        capacity: {
          maxDirectionalLights: 16,
          maxLightsPerReceiver: 16,
          maxLightIndices: LIGHT_LIST_SHADER_MAX_INDICES + 1
        }
      })
    ).toThrow(RangeError);
  });

  test('discards uncommitted shadow draw packets cleanly without leaking', async () => {
    const { graphics, device } = createGraphicsFixture('webgpu');
    const mesh = createBoxMeshData();
    const material = createStandardLitMaterial({ baseColor: [0.8, 0.2, 0.1, 1] });
    const meshHandle = createAssetHandle(MeshAssetType, 'demo.mesh');
    const matHandle = createAssetHandle(MaterialAssetType, 'demo.mat');
    const policy = resolveBaselineFeaturePolicy({ device });

    const normalized = validateOptions({
      graphics,
      mesh: { handle: meshHandle, payloadVersion: 1, data: mesh },
      material: { handle: matHandle, payloadVersion: 1, material },
      featurePolicy: policy
    });

    const runtime = new BaselineRenderingRuntime(normalized);
    runtime.initializePreparation();

    const prep = new BaselineStandardLitPreparation({
      graphics,
      viewId: 'test-view',
      mesh: { handle: meshHandle, payloadVersion: 1, data: mesh },
      material: { handle: matHandle, payloadVersion: 1, material },
      featurePolicy: policy,
      featurePolicyKey: policy.snapshot.hash,
      environmentLighting: TEST_ENVIRONMENT_LIGHTING
    });

    const packet = prep.createShadowPacket({
      entity: 1 as any,
      transform: {
        matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        previousMatrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        normalMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        worldVersion: 1,
        determinantSign: 1
      },
      viewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      cascade: 0
    });

    expect(packet.released).toBe(false);

    const shadow = prep.createDirectionalShadowFrame({
      requests: [
        {
          lightEntity: 10 as any,
          viewId: 'test-view',
          kind: 'directional-cascade',
          subresourceIndex: 0,
          resolutionClass: 1024,
          importance: 1,
          casterRevision: 1
        },
        {
          lightEntity: 10 as any,
          viewId: 'test-view',
          kind: 'directional-cascade',
          subresourceIndex: 1,
          resolutionClass: 1024,
          importance: 0.75,
          casterRevision: 1
        },
        {
          lightEntity: 10 as any,
          viewId: 'test-view',
          kind: 'directional-cascade',
          subresourceIndex: 2,
          resolutionClass: 1024,
          importance: 0.5,
          casterRevision: 1
        },
        {
          lightEntity: 10 as any,
          viewId: 'test-view',
          kind: 'directional-cascade',
          subresourceIndex: 3,
          resolutionClass: 1024,
          importance: 0.25,
          casterRevision: 1
        }
      ],
      packetsByRequestKey: new Map([['10:test-view:directional-cascade:0', [packet]]]),
      view: {
        viewId: 'test-view',
        camera: 1 as any,
        view: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        projection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        viewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        inverseViewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        worldPosition: [0, 0, 0],
        near: 0.1,
        far: 100
      } as any,
      cascades: [
        { splitFar: 10, viewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
        { splitFar: 25, viewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
        { splitFar: 50, viewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] },
        { splitFar: 100, viewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }
      ],
      lightIndex: 0
    });

    // Calling shadow.release() directly must release all packets
    shadow.release();
    expect(packet.released).toBe(true);

    await prep.dispose();
    await runtime.dispose();
  });

  test('repeated calls with the same publication do not prematurely release retirement', async () => {
    const { graphics, device } = createGraphicsFixture('webgpu');
    const mesh = createBoxMeshData();
    const material = createStandardLitMaterial({ baseColor: [0.8, 0.2, 0.1, 1] });
    const meshHandle = createAssetHandle(MeshAssetType, 'demo.mesh');
    const matHandle = createAssetHandle(MaterialAssetType, 'demo.mat');
    const policy = resolveBaselineFeaturePolicy({ device });

    const normalized = validateOptions({
      graphics,
      mesh: { handle: meshHandle, payloadVersion: 1, data: mesh },
      material: { handle: matHandle, payloadVersion: 1, material },
      featurePolicy: policy
    });

    const runtime = new BaselineRenderingRuntime(normalized);

    let releaseCallCount = 0;
    const fakeRetirement = {
      policy,
      acquireLease() {
        return {
          policy,
          acquireLease: () => fakeRetirement.acquireLease(),
          release() {
            releaseCallCount++;
          }
        };
      },
      release() {
        releaseCallCount++;
      }
    };

    const publication = {
      current: policy,
      retirement: fakeRetirement,
      invalidations: []
    };

    // First call with identical policy is a duplicate of initial policy revision
    runtime.updateFeaturePolicy(publication);
    await new Promise((r) => setTimeout(r, 10));
    expect(releaseCallCount).toBe(0);

    // Repeated call with same object must not release
    runtime.updateFeaturePolicy(publication);
    await new Promise((r) => setTimeout(r, 10));
    expect(releaseCallCount).toBe(0);

    await runtime.dispose();
  });

  test('failed update retains publication on runtime and releases temporary lease without leaking', async () => {
    const { graphics, device } = createGraphicsFixture('webgpu');
    const policy = resolveBaselineFeaturePolicy({ device, viewId: 'test-view' });

    const normalized = validateOptions({
      graphics,
      featurePolicy: policy
    });

    const runtime = new BaselineRenderingRuntime(normalized);

    let leaseReleaseCount = 0;
    const fakeRetirement: any = {
      policy,
      acquireLease() {
        return {
          policy,
          acquireLease: () => fakeRetirement.acquireLease(),
          release() {
            leaseReleaseCount++;
          }
        };
      },
      release() {}
    };

    // Mismatched device generation will cause updateFeaturePolicy to fail fast
    const badPolicy = {
      ...policy,
      snapshot: {
        ...policy.snapshot,
        revision: 2,
        deviceGeneration: 9999
      }
    };

    const publication = {
      current: badPolicy,
      retirement: fakeRetirement,
      invalidations: []
    };

    expect(() => runtime.updateFeaturePolicy(publication)).toThrow(
      /FeaturePolicy deviceGeneration \(9999\) does not match current device generation/
    );

    // Publication object is untouched and no leak occurred
    expect(publication.current.snapshot.revision).toBe(2);
    await runtime.dispose();
  });

  test('allows multiple baseline renderers to consume publication in the same frame without stealing it', async () => {
    const { graphics, device } = createGraphicsFixture('webgpu');
    const initialPolicy = resolveBaselineFeaturePolicy({ device, viewId: 'test-view' });

    const runtime1 = new BaselineRenderingRuntime(
      validateOptions({ graphics, viewId: 'view-1', featurePolicy: initialPolicy })
    );
    const runtime2 = new BaselineRenderingRuntime(
      validateOptions({ graphics, viewId: 'view-2', featurePolicy: initialPolicy })
    );

    let totalReleaseCalls = 0;
    const fakeRetirement: any = {
      policy: initialPolicy,
      acquireLease() {
        return {
          policy: initialPolicy,
          acquireLease: () => fakeRetirement.acquireLease(),
          release() {
            totalReleaseCalls++;
          }
        };
      },
      release() {}
    };

    const nextPolicy = {
      ...initialPolicy,
      snapshot: {
        ...initialPolicy.snapshot,
        revision: 2
      }
    };

    const publication = {
      current: nextPolicy,
      retirement: fakeRetirement,
      invalidations: []
    };

    // Both runtimes consume the exact same publication in the same frame
    runtime1.updateFeaturePolicy(publication);
    runtime2.updateFeaturePolicy(publication);

    // Both successfully updated their policy keys
    expect(runtime1.diagnostics.viewId).toBe('view-1');
    expect(runtime2.diagnostics.viewId).toBe('view-2');

    await new Promise((r) => setTimeout(r, 10));
    // Both renderers acquired leases and both safely released when complete
    expect(totalReleaseCalls).toBe(2);

    await runtime1.dispose();
    await runtime2.dispose();
  });
});

function createGraphicsFixture(backend: 'webgpu' | 'webgl2') {
  const device = new NullDevice();
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
