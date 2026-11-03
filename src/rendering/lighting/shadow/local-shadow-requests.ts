import type { PreparedLight, ShadowRequest } from '../types';

/** Builds deterministic per-view spot and point shadow requests from visible local lights. */
export function buildLocalShadowRequests(input: {
  readonly viewId: string;
  readonly lights: readonly PreparedLight[];
  readonly resolutionClass: number;
  readonly casterRevision: number;
}): readonly ShadowRequest[] {
  if (!input.viewId.trim()) throw new Error('Local shadow request viewId must be non-empty.');
  if (!Number.isSafeInteger(input.resolutionClass) || input.resolutionClass <= 0) {
    throw new Error('Local shadow request resolutionClass must be a positive integer.');
  }
  if (!Number.isSafeInteger(input.casterRevision) || input.casterRevision < 0) {
    throw new Error('Local shadow request casterRevision must be a non-negative integer.');
  }
  const requests: ShadowRequest[] = [];
  for (const light of [...input.lights].sort((left, right) => left.entity - right.entity)) {
    if (!light.enabled || !light.castsShadow || light.kind === 'directional') continue;
    if (light.kind === 'spot') {
      requests.push(
        Object.freeze({
          lightEntity: light.entity,
          viewId: input.viewId,
          kind: 'spot',
          subresourceIndex: 0,
          resolutionClass: input.resolutionClass,
          importance: light.luminousIntensityCandela,
          casterRevision: input.casterRevision
        })
      );
      continue;
    }
    for (let face = 0; face < 6; face++) {
      requests.push(
        Object.freeze({
          lightEntity: light.entity,
          viewId: input.viewId,
          kind: 'point-face',
          subresourceIndex: face,
          resolutionClass: input.resolutionClass,
          importance: light.luminousIntensityCandela,
          casterRevision: input.casterRevision
        })
      );
    }
  }
  return Object.freeze(requests);
}
