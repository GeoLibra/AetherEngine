import type { Entity } from '../../../ecs/types';
import type { CameraProjection, ExtractedView } from './camera-types';
import type { RenderTransformFact } from '../../mesh/types';
import type { RenderView } from '../../visibility/types';
import type { RenderRevision } from '../../world';

/** MainWorld camera intent independent from any platform surface. */
export interface CameraRenderSourceView {
  readonly projection: CameraProjection;
  readonly viewportRect: Readonly<{ x: number; y: number; width: number; height: number }>;
  readonly layerMask: number;
  readonly depthMode: 'standard' | 'reverse';
  readonly historyKey: string;
}

/** Composition-layer binding from one MainWorld camera to one physical surface view. */
export interface CameraSurfaceViewBinding {
  readonly camera: Entity;
  readonly viewId: string;
  readonly surface: string;
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  readonly devicePixelRatio: number;
  readonly featurePolicyKey: string;
  readonly jitterPixels?: readonly [number, number];
  readonly projection?: ArrayLike<number>;
  readonly unjitteredProjection?: ArrayLike<number>;
}

/** Inputs and immutable results for one camera extraction publication. */
export interface CameraExtractionInput {
  readonly sourceTick: number;
  readonly transforms: ReadonlyMap<Entity, RenderTransformFact>;
  readonly bindings: readonly CameraSurfaceViewBinding[];
}

export interface CameraExtractionResult {
  readonly revision: RenderRevision;
  readonly views: readonly ExtractedView[];
  readonly visibilityViews: readonly RenderView[];
}
