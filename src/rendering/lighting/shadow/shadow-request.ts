import type { ShadowBudget, ShadowRequest, ShadowRequestSelection } from '../types';

/** Stable logical request identity; quality/resolution revisions do not allocate a second owner. */
export function shadowRequestKey(request: ShadowRequest): string {
  validateShadowRequest(request);
  return JSON.stringify([
    request.lightEntity,
    request.viewId,
    request.kind,
    request.subresourceIndex
  ]);
}

export function selectShadowRequests(
  requests: readonly ShadowRequest[],
  budget: ShadowBudget
): ShadowRequestSelection {
  validateBudget(budget);
  const ordered = [...requests];
  for (const request of ordered) validateShadowRequest(request);
  ordered.sort(compareRequests);
  const accepted: ShadowRequest[] = [];
  const rejected: { request: ShadowRequest; reason: 'request-capacity' | 'texel-capacity' }[] = [];
  let usedTexels = 0;
  for (const request of ordered) {
    const cost = request.resolutionClass * request.resolutionClass;
    if (accepted.length >= budget.maxRequests) {
      rejected.push(
        Object.freeze({ request: snapshotShadowRequest(request), reason: 'request-capacity' })
      );
    } else if (usedTexels + cost > budget.maxTexels) {
      rejected.push(
        Object.freeze({ request: snapshotShadowRequest(request), reason: 'texel-capacity' })
      );
    } else {
      accepted.push(snapshotShadowRequest(request));
      usedTexels += cost;
    }
  }
  return Object.freeze({
    accepted: Object.freeze(accepted),
    rejected: Object.freeze(rejected),
    usedTexels
  });
}

function snapshotShadowRequest(request: ShadowRequest): ShadowRequest {
  return Object.freeze({
    lightEntity: request.lightEntity,
    viewId: request.viewId,
    kind: request.kind,
    subresourceIndex: request.subresourceIndex,
    resolutionClass: request.resolutionClass,
    importance: request.importance,
    casterRevision: request.casterRevision
  });
}

export function createShadowCacheKey(input: {
  readonly request: ShadowRequest;
  readonly lightTransformRevision: number;
  readonly projectionRevision: number;
  readonly materialShadowVariant: string;
  readonly atlasGeneration: number;
}): string {
  validateRevision(input.lightTransformRevision, 'light transform');
  validateRevision(input.projectionRevision, 'projection');
  validateRevision(input.atlasGeneration, 'atlas generation', true);
  if (!input.materialShadowVariant) throw new Error('Shadow material variant must be non-empty.');
  return JSON.stringify([
    shadowRequestKey(input.request),
    input.request.casterRevision,
    input.request.resolutionClass,
    input.lightTransformRevision,
    input.projectionRevision,
    input.materialShadowVariant,
    input.atlasGeneration
  ]);
}

function compareRequests(left: ShadowRequest, right: ShadowRequest): number {
  return (
    right.importance - left.importance ||
    left.lightEntity - right.lightEntity ||
    left.viewId.localeCompare(right.viewId) ||
    left.kind.localeCompare(right.kind) ||
    left.subresourceIndex - right.subresourceIndex
  );
}

function validateShadowRequest(request: ShadowRequest): void {
  validateRevision(request.lightEntity, 'shadow light entity');
  if (!request.viewId) throw new Error('Shadow request viewId must be non-empty.');
  if (!['directional-cascade', 'spot', 'point-face'].includes(request.kind)) {
    throw new Error('Shadow request kind is unsupported.');
  }
  validateRevision(request.subresourceIndex, 'shadow subresource index');
  validateExtent(request.resolutionClass, 'shadow resolutionClass');
  if (!Number.isSafeInteger(request.resolutionClass * request.resolutionClass)) {
    throw new Error('Shadow request texel cost exceeds the safe integer range.');
  }
  if (!Number.isFinite(request.importance) || request.importance < 0) {
    throw new Error('Shadow request importance must be non-negative and finite.');
  }
  validateRevision(request.casterRevision, 'shadow caster revision');
}

function validateBudget(budget: ShadowBudget): void {
  validateRevision(budget.maxRequests, 'shadow maxRequests');
  validateRevision(budget.maxTexels, 'shadow maxTexels');
}

function validateExtent(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer.`);
}

function validateRevision(value: number, name: string, positive = false): void {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) {
    throw new Error(`${name} must be a ${positive ? 'positive' : 'non-negative'} integer.`);
  }
}
