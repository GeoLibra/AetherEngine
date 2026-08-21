import { describe, expect, test } from 'vitest';
import {
  CameraIntentField,
  CameraRenderSource,
  CameraViewExtraction,
  RenderWorld,
  World,
  WorldTransform,
  createStandardRenderExtractorPlan,
  type CameraRenderSourceView,
  type Entity,
  type RenderTransformFact
} from '../../src';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;

function intent(): CameraRenderSourceView {
  return {
    projection: { kind: 'perspective', near: 0.1, far: 100, verticalFovRadians: Math.PI / 2 },
    viewportRect: { x: 0.25, y: 0, width: 0.5, height: 1 },
    layerMask: 3,
    depthMode: 'standard',
    historyKey: 'main-history'
  };
}

function transform(entity: Entity): RenderTransformFact {
  return {
    matrix: identity,
    previousMatrix: identity,
    normalMatrix: identity.slice(0, 9),
    determinantSign: 1,
    worldVersion: 1
  };
}

function fixture() {
  const main = new World();
  main.registerComponent(WorldTransform).registerComponent(CameraRenderSource);
  const render = new RenderWorld({ extractorPlan: createStandardRenderExtractorPlan() });
  const extraction = new CameraViewExtraction(main, render);
  return { main, render, extraction };
}

function spawn(main: World): Entity {
  return main
    .spawn()
    .insert(WorldTransform, {
      matrix: identity,
      previousMatrix: identity,
      normalMatrix: identity.slice(0, 9),
      worldVersion: 1,
      originCell: [0, 0, 0],
      determinantSign: 1
    })
    .insert(CameraRenderSource, { ...intent() })
    .build();
}

function binding(camera: Entity, logicalWidth = 800) {
  return {
    camera,
    viewId: 'main',
    surface: 'canvas',
    logicalWidth,
    logicalHeight: 600,
    devicePixelRatio: 2,
    featurePolicyKey: 'policy-a'
  } as const;
}

describe('camera surface View extraction', () => {
  test('combines MainWorld intent, transform, and surface metrics without storing platform state', () => {
    const { main, render, extraction } = fixture();
    const camera = spawn(main);
    const result = extraction.extract({
      sourceTick: 1,
      transforms: new Map([[camera, transform(camera)]]),
      bindings: [binding(camera)]
    });
    const view = result.views[0]!;
    expect(view.viewportPixels).toEqual({ x: 400, y: 0, width: 800, height: 1200 });
    expect(view.camera).toBe(render.mapEntity(camera));
    expect(render.read(view.camera, CameraIntentField)).toEqual(intent());
    expect('surface' in render.read(view.camera, CameraIntentField)!).toBe(false);

    const cpu = result.visibilityViews[0]!;
    expect(cpu.viewport).toEqual(view.viewportPixels);
    expect(cpu.surface).toBe('canvas');
    expect(cpu.featurePolicyKey).toBe('policy-a');
    expect(cpu.historyKey).toBe('main-history');
    expect(cpu.frustum).toBeDefined();
    result.revision.release();
  });

  test('rebuilds a View for resize/DPR input without mutating unchanged camera intent', () => {
    const { main, extraction } = fixture();
    const camera = spawn(main);
    extraction
      .extract({
        sourceTick: 1,
        transforms: new Map([[camera, transform(camera)]]),
        bindings: [binding(camera)]
      })
      .revision.release();
    const resized = extraction.extract({
      sourceTick: 1,
      transforms: new Map([[camera, transform(camera)]]),
      bindings: [binding(camera, 1000)]
    });
    expect(resized.views[0]!.viewportPixels).toEqual({ x: 500, y: 0, width: 1000, height: 1200 });
    expect(resized.views[0]!.revision).toBe(2);
    expect(resized.revision.diff.changes).toEqual([]);
    resized.revision.release();
  });

  test('rejects invalid jitter bindings before publishing a RenderWorld revision', () => {
    const { main, render, extraction } = fixture();
    const camera = spawn(main);
    expect(() =>
      extraction.extract({
        sourceTick: 1,
        transforms: new Map([[camera, transform(camera)]]),
        bindings: [{ ...binding(camera), jitterPixels: [0.5, 0] }]
      })
    ).toThrow(/must provide projection/i);
    expect(render.revision).toBe(0);
  });

  test('publishes a tombstone and a new generation after camera eligibility replacement', () => {
    const { main, render, extraction } = fixture();
    const camera = spawn(main);
    extraction
      .extract({
        sourceTick: 1,
        transforms: new Map([[camera, transform(camera)]]),
        bindings: [binding(camera)]
      })
      .revision.release();
    const previous = render.mapEntity(camera);
    main.removeComponent(camera, CameraRenderSource);
    main.insertComponent(camera, CameraRenderSource, { ...intent() });
    const result = extraction.extract({
      sourceTick: 2,
      transforms: new Map([[camera, transform(camera)]]),
      bindings: [binding(camera)]
    });
    expect(render.mapEntity(camera)).not.toBe(previous);
    expect(result.revision.diff.changes.map((change) => change.kind).sort()).toEqual([
      'entity-added',
      'entity-removed'
    ]);
    result.revision.release();
  });
});
