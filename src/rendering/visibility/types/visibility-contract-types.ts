import type { Vec3 } from '../../../math/types';
import type { Frustum } from '../../../math/frustum';
import type { RenderEntityId } from '../../render-world';

export type WorldBounds =
  | { readonly kind: 'sphere'; readonly center: Vec3; readonly radius: number }
  | { readonly kind: 'aabb'; readonly min: Vec3; readonly max: Vec3 };

export interface VisibilityCandidate {
  readonly entity: RenderEntityId;
  readonly enabled?: boolean;
  readonly layerMask: number;
  readonly bounds: WorldBounds;
  readonly boundsRevision?: number;
  readonly lod?: number;
  readonly visibilityFlags?: number;
}

export interface RenderView {
  readonly id: string;
  readonly camera: RenderEntityId;
  readonly surface: string;
  readonly viewport: Readonly<{ x: number; y: number; width: number; height: number }>;
  readonly layerMask: number;
  readonly featurePolicyKey: string;
  readonly historyKey: string;
  readonly viewRevision?: number;
  readonly frustum?: Frustum;
  readonly viewMatrix?: ArrayLike<number>;
}

export interface VisibleItem {
  readonly renderEntity: RenderEntityId;
  readonly boundsRevision: number;
  readonly depthRange: readonly [number, number];
  readonly lod: number;
  readonly visibilityFlags: number;
}

export interface VisibilityCounters {
  readonly candidates: number;
  readonly layerRejected: number;
  readonly disabledRejected: number;
  readonly frustumRejected: number;
  readonly retained: number;
  readonly planeTests: number;
  readonly conservativeFallbackRetained: number;
}

export interface ViewVisibilitySnapshot {
  readonly viewId: string;
  readonly viewRevision: number;
  readonly source: 'cpu';
  readonly entities: readonly RenderEntityId[];
  readonly items: readonly VisibleItem[];
  readonly overflowed: false;
  readonly counters: VisibilityCounters;
}

export interface CpuVisibilityViewOptions {
  readonly surface: string;
  readonly featurePolicyKey: string;
  readonly historyKey: string;
}
