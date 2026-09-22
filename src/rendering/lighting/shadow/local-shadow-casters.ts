import type { PreparedLight, ShadowRequest } from '../types';
import {
  buildPointShadowFaceViewProjection,
  buildSpotShadowViewProjection
} from './shadow-receiver';

/** Immutable projection payload consumed by one local-light depth caster pass. */
export interface LocalShadowCasterView {
  readonly request: ShadowRequest;
  readonly viewProjection: readonly number[];
}

/**
 * Resolves accepted local shadow requests into deterministic caster view-projection matrices.
 * Point request subresources map directly to the canonical cube-face order 0..5; spot accepts
 * only subresource zero. Requests whose light is not a matching shadow-casting local light fail
 * fast because a stale atlas entry must never render with another light's transform.
 */
export function buildLocalShadowCasterViews(input: {
  readonly requests: readonly ShadowRequest[];
  readonly lights: readonly PreparedLight[];
}): readonly LocalShadowCasterView[] {
  const lights = new Map(input.lights.map((light) => [light.entity, light]));
  return Object.freeze(
    input.requests.map((request) => {
      const light = lights.get(request.lightEntity);
      if (
        light === undefined ||
        !light.enabled ||
        !light.castsShadow ||
        light.kind === 'directional'
      ) {
        throw new Error(
          `Local shadow request references unavailable light ${request.lightEntity}.`
        );
      }
      if (request.kind === 'spot') {
        if (light.kind !== 'spot' || request.subresourceIndex !== 0) {
          throw new Error('Spot shadow requests require a spot light and subresource index 0.');
        }
        return Object.freeze({
          request,
          viewProjection: Object.freeze(
            buildSpotShadowViewProjection({
              position: light.position,
              direction: light.direction,
              range: light.range,
              outerRadians: light.outerRadians
            })
          )
        });
      }
      if (request.kind === 'point-face') {
        if (
          light.kind !== 'point' ||
          request.subresourceIndex < 0 ||
          request.subresourceIndex > 5
        ) {
          throw new Error('Point shadow requests require a point light and face index in [0, 5].');
        }
        return Object.freeze({
          request,
          viewProjection: Object.freeze(
            buildPointShadowFaceViewProjection({
              position: light.position,
              face: request.subresourceIndex,
              near: light.range * 1e-4,
              far: light.range
            })
          )
        });
      }
      throw new Error('Directional cascade requests are not local shadow caster views.');
    })
  );
}
