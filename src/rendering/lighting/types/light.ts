import type { Vec3 } from '../../../math/types';
import type { RenderEntityId } from '../../world';

export type LinearRgb = Vec3;

/** Validated MainWorld intent for one world-space directional light. */
export interface DirectionalLightSourceView {
  readonly direction: Vec3;
  readonly colorLinear: LinearRgb;
  readonly illuminanceLux: number;
  readonly enabled: boolean;
  readonly layerMask: number;
  readonly castsShadow: boolean;
}

/** Monotonic source boundary for directional-light RenderWorld publication. */
export interface DirectionalLightExtractionInput {
  readonly sourceTick: number;
}

export interface LightCommon {
  readonly entity: RenderEntityId;
  readonly payloadVersion: number;
  readonly colorLinear: LinearRgb;
  readonly enabled: boolean;
  readonly layerMask: number;
  readonly castsShadow: boolean;
}

export type PreparedLight =
  | (LightCommon & {
      readonly kind: 'directional';
      readonly direction: Vec3;
      readonly illuminanceLux: number;
    })
  | (LightCommon & {
      readonly kind: 'point';
      readonly position: Vec3;
      readonly luminousIntensityCandela: number;
      readonly range: number;
    })
  | (LightCommon & {
      readonly kind: 'spot';
      readonly position: Vec3;
      readonly direction: Vec3;
      readonly luminousIntensityCandela: number;
      readonly range: number;
      readonly innerRadians: number;
      readonly outerRadians: number;
    });
