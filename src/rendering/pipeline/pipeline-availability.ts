import type {
  AvailablePipelinePhaseItem,
  PipelineAvailabilityIdentity,
  PipelineAvailabilityRequest,
  PipelineAvailabilityResult,
  PipelineAvailabilitySkip,
  PipelineAvailabilitySkipCode,
  PipelineCacheEntryState,
  PipelineCompileDiagnostic,
  PipelineReadyLease
} from './types';

/**
 * Resolves a Queue item from immutable cache snapshots without compiling or waiting.
 *
 * @returns A ready primary/fallback pipeline or a structured availability skip.
 * @throws When the item association or compatibility identity is malformed.
 */
export function resolvePipelineAvailability(
  request: PipelineAvailabilityRequest
): PipelineAvailabilityResult {
  validateRequest(request);
  if (request.primary.kind === 'ready') {
    if (
      request.primary.deviceGeneration !== request.identity.deviceGeneration ||
      request.primaryLease === undefined ||
      request.primaryLease.released
    )
      return skipped(request, 'device-generation-stale');
    validateReadyLease(request.primary, request.primaryLease, request.bound.item.pipelineKey);
    return ready(request, request.primaryLease, 'primary');
  }

  if (request.fallback !== undefined) {
    if (!sameIdentity(request.identity, request.fallback.identity))
      return skipped(request, 'fallback-incompatible');
    if (request.fallback.state.kind === 'ready') {
      if (
        request.fallback.state.deviceGeneration !== request.identity.deviceGeneration ||
        request.fallback.lease === undefined ||
        request.fallback.lease.released
      )
        return skipped(request, 'fallback-incompatible');
      validateReadyLease(request.fallback.state, request.fallback.lease);
      return ready(request, request.fallback.lease, 'fallback');
    }
  }

  if (request.primary.kind === 'errored')
    return skipped(request, 'pipeline-error', request.primary.diagnostic);
  if (request.primary.kind === 'stale' && request.primary.reason === 'device-generation-changed')
    return skipped(request, 'device-generation-stale');
  return skipped(request, 'pipeline-compiling');
}

function ready(
  request: PipelineAvailabilityRequest,
  lease: PipelineReadyLease,
  selection: AvailablePipelinePhaseItem['selection']
): AvailablePipelinePhaseItem {
  return Object.freeze({
    status: 'ready',
    bound: request.bound,
    pipeline: lease.pipeline,
    pipelineLease: lease,
    selection
  });
}

function validateReadyLease(
  state: Extract<PipelineCacheEntryState, { readonly kind: 'ready' }>,
  lease: PipelineReadyLease,
  expectedPipelineKey?: string
): void {
  if (
    lease.pipeline !== state.pipeline ||
    lease.deviceGeneration !== state.deviceGeneration ||
    (expectedPipelineKey !== undefined && lease.pipelineKey !== expectedPipelineKey)
  )
    throw new Error('Pipeline availability lease does not match the ready cache state.');
}

function skipped(
  request: PipelineAvailabilityRequest,
  code: PipelineAvailabilitySkipCode,
  diagnostic?: PipelineCompileDiagnostic
): PipelineAvailabilitySkip {
  return Object.freeze({
    status: 'skipped',
    entity: request.bound.item.entity,
    reason: 'pipeline-unavailable',
    code,
    ...(diagnostic === undefined
      ? {}
      : { diagnostic: Object.freeze({ code: diagnostic.code, message: diagnostic.message }) })
  });
}

function validateRequest(request: PipelineAvailabilityRequest): void {
  if (request.bound.item.phase !== request.identity.phase)
    throw new Error('Pipeline availability phase mismatch.');
  validateIdentity(request.identity);
  if (request.fallback !== undefined) validateIdentity(request.fallback.identity);
}

function validateIdentity(identity: PipelineAvailabilityIdentity): void {
  for (const [name, value] of [
    ['semantic tag', identity.semanticTag],
    ['binding layout hash', identity.bindingLayoutHash],
    ['vertex layout hash', identity.vertexLayoutHash],
    ['FeaturePolicy hash', identity.featurePolicyHash],
    ['backend target', identity.backendTarget]
  ] as const)
    if (typeof value !== 'string' || !value.trim())
      throw new Error(`Pipeline availability ${name} must be non-empty.`);
  for (const format of identity.attachmentFormats)
    if (typeof format !== 'string' || !format.trim())
      throw new Error('Pipeline availability attachment format must be non-empty.');
  if (
    identity.depthStencilFormat !== undefined &&
    (typeof identity.depthStencilFormat !== 'string' || !identity.depthStencilFormat.trim())
  )
    throw new Error('Pipeline availability depth format must be non-empty.');
  if (!Number.isSafeInteger(identity.sampleCount) || identity.sampleCount < 1)
    throw new Error('Pipeline availability sample count must be a positive safe integer.');
  if (!Number.isSafeInteger(identity.deviceGeneration) || identity.deviceGeneration < 0)
    throw new Error('Pipeline availability device generation must be non-negative.');
}

function sameIdentity(
  left: PipelineAvailabilityIdentity,
  right: PipelineAvailabilityIdentity
): boolean {
  return (
    left.phase === right.phase &&
    left.semanticTag === right.semanticTag &&
    left.bindingLayoutHash === right.bindingLayoutHash &&
    left.vertexLayoutHash === right.vertexLayoutHash &&
    sameStrings(left.attachmentFormats, right.attachmentFormats) &&
    left.depthStencilFormat === right.depthStencilFormat &&
    left.sampleCount === right.sampleCount &&
    left.featurePolicyHash === right.featurePolicyHash &&
    left.backendTarget === right.backendTarget &&
    left.deviceGeneration === right.deviceGeneration
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
