import {
  CameraRenderSource,
  CameraViewExtraction,
  RenderWorld,
  World,
  WorldTransform,
  createStandardRenderExtractorPlan,
  type CameraSurfaceViewBinding,
  type Entity,
  type RenderTransformFact
} from '../../src';

const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export interface CameraExtractionBenchmarkResult {
  readonly views: number;
  readonly pixelWidthChecksum: number;
  readonly viewRevisionChecksum: number;
}

/** Exercises camera intent extraction and per-surface immutable view composition. */
export function runCameraExtractionSubject(size: number): CameraExtractionBenchmarkResult {
  const main = new World();
  main.registerComponent(WorldTransform).registerComponent(CameraRenderSource);
  const render = new RenderWorld({ extractorPlan: createStandardRenderExtractorPlan() });
  const extraction = new CameraViewExtraction(main, render);
  const transforms = new Map<Entity, RenderTransformFact>();
  const bindings: CameraSurfaceViewBinding[] = [];
  for (let index = 0; index < size; index += 1) {
    const camera = main
      .spawn()
      .insert(WorldTransform, {
        matrix: IDENTITY,
        previousMatrix: IDENTITY,
        normalMatrix: IDENTITY.slice(0, 9),
        worldVersion: 1,
        originCell: [0, 0, 0],
        determinantSign: 1
      })
      .insert(CameraRenderSource, {
        projection: {
          kind: 'perspective',
          near: 0.1,
          far: 1_000,
          verticalFovRadians: Math.PI / 3
        },
        viewportRect: { x: 0, y: 0, width: 1, height: 1 },
        layerMask: 1,
        depthMode: 'reverse',
        historyKey: `camera:${index}`
      })
      .build();
    transforms.set(camera, {
      matrix: IDENTITY,
      previousMatrix: IDENTITY,
      normalMatrix: IDENTITY.slice(0, 9),
      determinantSign: 1,
      worldVersion: 1
    });
    bindings.push({
      camera,
      viewId: `view:${index}`,
      surface: `surface:${index % 2}`,
      logicalWidth: 640 + index,
      logicalHeight: 360,
      devicePixelRatio: 2,
      featurePolicyKey: 'benchmark-policy'
    });
  }
  const result = extraction.extract({ sourceTick: 1, transforms, bindings });
  const benchmarkResult = {
    views: result.views.length,
    pixelWidthChecksum: result.views.reduce((sum, view) => sum + view.viewportPixels.width, 0),
    viewRevisionChecksum: result.views.reduce((sum, view) => sum + view.revision, 0)
  };
  result.revision.release();
  extraction.dispose();
  return benchmarkResult;
}

/** Independent scalar oracle for the deterministic camera binding workload. */
export function cameraExtractionReference(size: number): CameraExtractionBenchmarkResult {
  return {
    views: size,
    pixelWidthChecksum: 2 * (size * 640 + (size * (size - 1)) / 2),
    viewRevisionChecksum: size
  };
}
