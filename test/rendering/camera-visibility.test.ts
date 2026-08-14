import { describe, expect, test } from 'vitest';
import { Frustum, Mat4 } from '../../src/math';
import {
  computeViewportPixels,
  computeVisibility,
  conservativeSphereFromScale,
  createCpuVisibilityView,
  extractView,
  CameraViewError,
  type RenderEntityId,
  type RenderView,
  type VisibilityCandidate
} from '../../src/rendering';

const entity = (value: number) => value as RenderEntityId;
type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

type RenderViewKeys = Expect<
  Equal<
    keyof RenderView,
    | 'id'
    | 'camera'
    | 'surface'
    | 'viewport'
    | 'layerMask'
    | 'featurePolicyKey'
    | 'historyKey'
    | 'viewRevision'
    | 'frustum'
    | 'viewMatrix'
  >
>;
type VisibilityCandidateKeys = Expect<
  Equal<
    keyof VisibilityCandidate,
    'entity' | 'enabled' | 'layerMask' | 'bounds' | 'boundsRevision' | 'lod' | 'visibilityFlags'
  >
>;

const exactVisibilityContracts: readonly [RenderViewKeys, VisibilityCandidateKeys] = [true, true];

describe('camera extraction', () => {
  test('uses physical pixels and publishes matching inverse matrices', () => {
    const projection = Mat4.perspective(Math.PI / 2, 2, 0.1, 100);
    const extracted = extractView({
      viewId: 'main',
      camera: entity(99),
      revision: 3,
      view: Mat4.identity(),
      projection,
      projectionDescriptor: {
        kind: 'perspective',
        near: 0.1,
        far: 100,
        verticalFovRadians: Math.PI / 2
      },
      viewport: {
        logicalWidth: 800,
        logicalHeight: 600,
        devicePixelRatio: 2,
        rect: { x: 0.25, y: 0, width: 0.5, height: 1 }
      },
      layerMask: 1
    });
    expect(extracted.viewportPixels).toEqual({ x: 400, y: 0, width: 800, height: 1200 });
    expect(Mat4.multiply(extracted.viewProjection, extracted.inverseViewProjection)).toEqual(
      expect.any(Float32Array)
    );
  });

  test('rejects invalid projection, viewport, and singular matrices', () => {
    expect(() =>
      computeViewportPixels({ logicalWidth: 1, logicalHeight: 1, devicePixelRatio: 0 })
    ).toThrow(/viewport/i);
    expect(() =>
      extractView({
        viewId: 'bad',
        camera: entity(42),
        revision: 0,
        view: new Float32Array(16),
        projection: Mat4.identity(),
        projectionDescriptor: { kind: 'perspective', near: 0, far: 1, verticalFovRadians: 1 },
        viewport: { logicalWidth: 1, logicalHeight: 1, devicePixelRatio: 1 },
        layerMask: 1
      })
    ).toThrow(/near/i);
  });

  test('uses an unjittered projection for the CPU visibility bridge', () => {
    const unjittered = Mat4.perspective(Math.PI / 2, 1, 0.1, 10);
    const jittered = new Float32Array(unjittered);
    jittered[8] = 0.02;
    const extracted = extractView({
      viewId: 'jittered',
      camera: entity(7),
      revision: 4,
      view: Mat4.identity(),
      projection: jittered,
      unjitteredProjection: unjittered,
      projectionDescriptor: {
        kind: 'perspective',
        near: 0.1,
        far: 10,
        verticalFovRadians: Math.PI / 2
      },
      viewport: { logicalWidth: 100, logicalHeight: 100, devicePixelRatio: 1 },
      layerMask: 3,
      jitterPixels: [1, 0]
    });
    const visibilityView = createCpuVisibilityView(extracted, {
      surface: 'main',
      featurePolicyKey: 'cpu',
      historyKey: 'main'
    });

    expect(visibilityView.frustum?.planes).toEqual(Frustum.fromViewProjection(unjittered).planes);
    expect(visibilityView.viewMatrix).toEqual(extracted.view);
  });

  test('copies and freezes caller-owned jitter pixels', () => {
    const jitterPixels: [number, number] = [1, -1];
    const extracted = extractView({
      viewId: 'jitter-owned',
      camera: entity(7),
      revision: 4,
      view: Mat4.identity(),
      projection: Mat4.perspective(Math.PI / 2, 1, 0.1, 10),
      unjitteredProjection: Mat4.perspective(Math.PI / 2, 1, 0.1, 10),
      projectionDescriptor: {
        kind: 'perspective',
        near: 0.1,
        far: 10,
        verticalFovRadians: Math.PI / 2
      },
      viewport: { logicalWidth: 100, logicalHeight: 100, devicePixelRatio: 1 },
      layerMask: 3,
      jitterPixels
    });

    jitterPixels[0] = 99;

    expect(extracted.jitterPixels).toEqual([1, -1]);
    expect(Object.isFrozen(extracted.jitterPixels)).toBe(true);
  });

  test('detaches CPU visibility data from an externally owned extracted view', () => {
    const source = extractView({
      viewId: 'external',
      camera: entity(9),
      revision: 5,
      view: Mat4.identity(),
      projection: Mat4.perspective(Math.PI / 2, 1, 0.1, 10),
      projectionDescriptor: {
        kind: 'perspective',
        near: 0.1,
        far: 10,
        verticalFovRadians: Math.PI / 2
      },
      viewport: { logicalWidth: 100, logicalHeight: 100, devicePixelRatio: 1 },
      layerMask: 1
    });
    const nestedExtra = { callerOwned: true };
    const extracted = {
      ...source,
      view: new Float32Array(source.view),
      viewportPixels: { ...source.viewportPixels, nestedExtra }
    };
    const visibilityView = createCpuVisibilityView(extracted, {
      surface: 'main',
      featurePolicyKey: 'cpu',
      historyKey: 'main'
    });

    extracted.view[0] = 99;
    extracted.viewportPixels.width = 7;

    expect(visibilityView.viewMatrix?.[0]).toBe(1);
    expect(visibilityView.viewport.width).toBe(100);
    expect('nestedExtra' in visibilityView.viewport).toBe(false);
  });

  test('reports camera identity when a view cannot be published', () => {
    expect(() =>
      extractView({
        viewId: 'singular',
        camera: entity(17),
        revision: 1,
        view: new Float32Array(16),
        projection: Mat4.identity(),
        projectionDescriptor: {
          kind: 'perspective',
          near: 0.1,
          far: 10,
          verticalFovRadians: 1
        },
        viewport: { logicalWidth: 1, logicalHeight: 1, devicePixelRatio: 1 },
        layerMask: 1
      })
    ).toThrow(
      expect.objectContaining<Partial<CameraViewError>>({ camera: entity(17), viewId: 'singular' })
    );
  });

  test('expands spheres by the maximum absolute non-uniform scale', () => {
    const center: [number, number, number] = [1, 2, 3];
    const sphere = conservativeSphereFromScale(center, 2, [-1, 4, 0.5]);
    center[0] = 99;

    expect(sphere).toEqual({
      center: [1, 2, 3],
      radius: 8
    });
  });
});

describe('CPU visibility', () => {
  const frustum = Frustum.fromViewProjection(Mat4.perspective(Math.PI / 2, 1, 0.1, 10));
  const view = {
    id: 'main',
    camera: entity(99),
    surface: 'surface',
    viewport: { x: 0, y: 0, width: 100, height: 100 },
    layerMask: 1,
    featurePolicyKey: 'cpu',
    historyKey: 'main',
    viewRevision: 7,
    frustum,
    viewMatrix: Mat4.identity()
  };

  test('keeps the public visibility contracts exact', () => {
    expect(exactVisibilityContracts).toEqual([true, true]);
  });

  test('conservatively filters sphere/AABB bounds and publishes stable items', () => {
    const result = computeVisibility(view, [
      {
        entity: entity(4),
        layerMask: 1,
        bounds: { kind: 'sphere', center: [0, 0, -2], radius: 0.5 },
        boundsRevision: 2
      },
      {
        entity: entity(2),
        layerMask: 1,
        bounds: { kind: 'aabb', min: [-0.5, -0.5, -1], max: [0.5, 0.5, -0.5] }
      },
      {
        entity: entity(1),
        layerMask: 2,
        bounds: { kind: 'sphere', center: [0, 0, -1], radius: 1 }
      },
      {
        entity: entity(3),
        enabled: false,
        layerMask: 1,
        bounds: { kind: 'sphere', center: [0, 0, -1], radius: 1 }
      },
      {
        entity: entity(5),
        layerMask: 1,
        bounds: { kind: 'sphere', center: [20, 0, -1], radius: 0.1 }
      }
    ]);
    expect(result.entities).toEqual([entity(2), entity(4)]);
    expect(result).toMatchObject({
      viewRevision: 7,
      source: 'cpu',
      overflowed: false,
      counters: {
        candidates: 5,
        layerRejected: 1,
        disabledRejected: 1,
        frustumRejected: 1,
        retained: 2
      }
    });
    expect(result.items.map((item) => item.depthRange)).toEqual([
      [-1, -0.5],
      [-2.5, -1.5]
    ]);
  });

  test('computes depth ranges in view space for a rotated camera', () => {
    const viewMatrix = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1]);
    const result = computeVisibility(
      {
        id: view.id,
        camera: view.camera,
        surface: view.surface,
        viewport: view.viewport,
        layerMask: view.layerMask,
        featurePolicyKey: view.featurePolicyKey,
        historyKey: view.historyKey,
        viewRevision: view.viewRevision,
        viewMatrix
      },
      [
        {
          entity: entity(1),
          layerMask: 1,
          bounds: { kind: 'sphere', center: [5, 0, 0], radius: 1 }
        }
      ]
    );
    expect(result.items[0]?.depthRange).toEqual([4, 6]);
    expect(result.counters.conservativeFallbackRetained).toBe(1);
  });

  test('rejects non-finite sphere and AABB bounds', () => {
    expect(() => frustum.classifySphere([Number.NaN, 0, -1], 1)).toThrow(/sphere/i);
    expect(() => frustum.classifyAabb([0, 0, -1], [Number.POSITIVE_INFINITY, 1, 0])).toThrow(
      /AABB/i
    );
  });

  test('propagates plane masks without changing classification', () => {
    const parent = frustum.classifySphere([0, 0, -2], 0.5);
    expect(parent.intersection).toBe('inside');
    const child = frustum.classifySphere([0, 0, -2], 0.1, parent.planeMask);
    expect(child).toMatchObject({ intersection: 'inside', planeTests: 0 });
  });
});
