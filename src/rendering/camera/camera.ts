import { Mat4, type Vec3 } from '../../math';
import type { RenderEntityId } from '../world';
import type {
  CameraProjection,
  CameraViewportInput,
  ExtractedView,
  ExtractViewOptions
} from './types';

export function validateCameraProjection(projection: CameraProjection): void {
  if (!Number.isFinite(projection.near) || projection.near <= 0)
    throw new Error('Camera near plane must be finite and greater than zero.');
  if (
    projection.far !== 'infinite' &&
    (!Number.isFinite(projection.far) || projection.far <= projection.near)
  )
    throw new Error('Camera far plane must be greater than near.');
  if (
    projection.kind === 'perspective' &&
    (!Number.isFinite(projection.verticalFovRadians) ||
      projection.verticalFovRadians! <= 0 ||
      projection.verticalFovRadians! >= Math.PI)
  )
    throw new Error('Perspective camera requires a vertical FOV between zero and PI.');
  if (
    projection.kind === 'orthographic' &&
    (!Number.isFinite(projection.orthographicHalfHeight) || projection.orthographicHalfHeight! <= 0)
  )
    throw new Error('Orthographic camera requires a positive half height.');
}

export function computeViewportPixels(
  input: CameraViewportInput
): Readonly<{ x: number; y: number; width: number; height: number }> {
  const rect = input.rect ?? { x: 0, y: 0, width: 1, height: 1 };
  const values = [
    input.logicalWidth,
    input.logicalHeight,
    input.devicePixelRatio,
    rect.x,
    rect.y,
    rect.width,
    rect.height
  ];
  if (
    values.some((value) => !Number.isFinite(value)) ||
    input.logicalWidth < 0 ||
    input.logicalHeight < 0 ||
    input.devicePixelRatio <= 0 ||
    rect.x < 0 ||
    rect.y < 0 ||
    rect.width < 0 ||
    rect.height < 0 ||
    rect.x + rect.width > 1 ||
    rect.y + rect.height > 1
  )
    throw new Error('Camera viewport and surface dimensions must be finite and normalized.');
  const physicalWidth = Math.round(input.logicalWidth * input.devicePixelRatio);
  const physicalHeight = Math.round(input.logicalHeight * input.devicePixelRatio);
  return Object.freeze({
    x: Math.round(rect.x * physicalWidth),
    y: Math.round(rect.y * physicalHeight),
    width: Math.round(rect.width * physicalWidth),
    height: Math.round(rect.height * physicalHeight)
  });
}

export function extractView(options: ExtractViewOptions): ExtractedView {
  validateCameraProjection(options.projectionDescriptor);
  const view = copyMatrix(options.view, 'view');
  const projection = copyMatrix(options.projection, 'projection');
  if (!options.unjitteredProjection && options.jitterPixels?.some((value) => value !== 0)) {
    throw new CameraViewError(
      options.camera,
      options.viewId,
      'A jittered camera must provide an unjittered projection for CPU culling.'
    );
  }
  const unjitteredProjection = copyMatrix(
    options.unjitteredProjection ?? projection,
    'unjittered projection'
  );
  const viewProjection = Mat4.multiply(projection, view);
  const unjitteredViewProjection = Mat4.multiply(unjitteredProjection, view);
  const jitterPixels = Object.freeze(
    options.jitterPixels === undefined ? [0, 0] : [options.jitterPixels[0], options.jitterPixels[1]]
  ) as readonly [number, number];
  let inverseViewProjection: Float32Array;
  let inverseView: Float32Array;
  try {
    inverseViewProjection = Mat4.invert(viewProjection);
    inverseView = Mat4.invert(view);
  } catch {
    throw new CameraViewError(
      options.camera,
      options.viewId,
      'View-projection matrix is non-invertible; the view was not published.'
    );
  }
  return Object.freeze({
    viewId: options.viewId,
    camera: options.camera,
    revision: options.revision,
    view: snapshotMatrix(view),
    projection: snapshotMatrix(projection),
    viewProjection: snapshotMatrix(viewProjection),
    inverseViewProjection: snapshotMatrix(inverseViewProjection),
    cameraPosition: Object.freeze([
      inverseView[12]!,
      inverseView[13]!,
      inverseView[14]!
    ]) as readonly [number, number, number],
    unjitteredProjection: snapshotMatrix(unjitteredProjection),
    unjitteredViewProjection: snapshotMatrix(unjitteredViewProjection),
    viewportPixels: computeViewportPixels(options.viewport),
    layerMask: options.layerMask,
    jitterPixels,
    depthMode: options.depthMode ?? 'standard'
  });
}

function snapshotMatrix(matrix: ArrayLike<number>): readonly number[] {
  return Object.freeze(Array.from(matrix));
}

export class CameraViewError extends Error {
  readonly code = 'camera/view-not-published';

  constructor(
    readonly camera: RenderEntityId,
    readonly viewId: string,
    message: string
  ) {
    super(`Camera entity ${camera}, view ${viewId}: ${message}`);
    this.name = 'CameraViewError';
  }
}

function copyMatrix(matrix: ArrayLike<number>, label: string): Float32Array {
  if (matrix.length !== 16 || Array.from(matrix).some((value) => !Number.isFinite(value)))
    throw new Error(`Camera ${label} matrix must contain 16 finite values.`);
  return new Float32Array(matrix);
}

export function conservativeSphereFromScale(
  center: Vec3,
  localRadius: number,
  scale: Vec3
): Readonly<{ center: Vec3; radius: number }> {
  if (
    !Number.isFinite(localRadius) ||
    localRadius < 0 ||
    scale.some((value) => !Number.isFinite(value))
  )
    throw new Error('Sphere transform inputs must be finite with a non-negative radius.');
  return Object.freeze({
    center: Object.freeze([...center]) as Vec3,
    radius: localRadius * Math.max(Math.abs(scale[0]), Math.abs(scale[1]), Math.abs(scale[2]))
  });
}
