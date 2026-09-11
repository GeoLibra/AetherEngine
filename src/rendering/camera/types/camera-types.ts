import type { RenderEntityId } from '../../world';

export interface CameraProjection {
  readonly kind: 'perspective' | 'orthographic';
  readonly near: number;
  readonly far: number | 'infinite';
  readonly verticalFovRadians?: number;
  readonly orthographicHalfHeight?: number;
}

export interface CameraViewportInput {
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  readonly devicePixelRatio: number;
  readonly rect?: Readonly<{ x: number; y: number; width: number; height: number }>;
}

export interface ExtractedView {
  readonly viewId: string;
  readonly camera: RenderEntityId;
  readonly revision: number;
  readonly view: ArrayLike<number>;
  readonly projection: ArrayLike<number>;
  readonly viewProjection: ArrayLike<number>;
  readonly inverseViewProjection: ArrayLike<number>;
  /** Camera origin in world space, expressed in engine world units. */
  readonly cameraPosition: readonly [number, number, number];
  readonly unjitteredProjection: ArrayLike<number>;
  readonly unjitteredViewProjection: ArrayLike<number>;
  readonly viewportPixels: Readonly<{ x: number; y: number; width: number; height: number }>;
  readonly layerMask: number;
  readonly jitterPixels: readonly [number, number];
  readonly depthMode: 'standard' | 'reverse';
  readonly projectionKind: 'perspective' | 'orthographic';
  /** Positive camera-space near distance in engine world units. */
  readonly near: number;
  /** Positive far distance in engine world units, or an explicitly infinite projection. */
  readonly far: number | 'infinite';
}

export interface ExtractViewOptions {
  readonly viewId: string;
  readonly camera: RenderEntityId;
  readonly revision: number;
  readonly view: ArrayLike<number>;
  readonly projection: ArrayLike<number>;
  readonly unjitteredProjection?: ArrayLike<number>;
  readonly projectionDescriptor: CameraProjection;
  readonly viewport: CameraViewportInput;
  readonly layerMask: number;
  readonly jitterPixels?: readonly [number, number];
  readonly depthMode?: 'standard' | 'reverse';
}
