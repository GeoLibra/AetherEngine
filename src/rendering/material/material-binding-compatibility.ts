import { resolveMaterialBindings } from './material-bindings';
import { createBindingKey } from '../pipeline/pipeline-resolver';
import { buildRenderPhase } from '../phase/render-phase';
import type { RenderPhaseKind } from '../phase/types';
import type {
  BoundMaterialPhaseItem,
  MaterialBindingCompatibilityRequest,
  MaterialBindingCompatibilityResult,
  MaterialBindingCompatibilitySkip,
  MaterialBindingCompatibilitySkipCode
} from './types';

/**
 * Resolves CPU binding compatibility and rebuilds a view-scoped phase snapshot.
 * This boundary creates no RHI objects and neither retains nor disposes prepared leases.
 *
 * @throws When view/phase/item association is malformed or an input item is already bound.
 */
export function resolveMaterialBindingCompatibility(
  viewId: string,
  phase: RenderPhaseKind,
  requests: readonly MaterialBindingCompatibilityRequest[]
): MaterialBindingCompatibilityResult {
  validateContext(viewId, phase, requests);
  const bound: BoundMaterialPhaseItem[] = [];
  const skipped: MaterialBindingCompatibilitySkip[] = [];
  for (const request of requests) {
    const allocationIssue = validateAllocation(request);
    if (allocationIssue !== undefined) {
      skipped.push(allocationIssue);
      continue;
    }
    const resolution = resolveMaterialBindings(
      request.layout,
      request.supplied,
      request.defaults,
      request.resolver
    );
    if (resolution.status === 'unsupported') {
      skipped.push(bindingSkip(request, skipCode(resolution.diagnostics), resolution.diagnostics));
      continue;
    }
    const resources = resolution.resources.map((resource, index) => {
      const entry = request.layout.entries[index];
      if (entry === undefined) throw new Error('Material binding resource order invariant failed.');
      return Object.freeze({
        group: entry.group,
        binding: entry.binding,
        assetId: resource.id,
        assetPayloadVersion: resource.payloadVersion,
        resourceGeneration: resource.resourceGeneration
      });
    });
    const bindingKey = createBindingKey({
      bindingLayoutHash: request.bindingPlan.hash,
      resources,
      bufferAllocationGeneration: request.allocation.bufferAllocationGeneration,
      ringGeneration: request.allocation.ringGeneration,
      dynamicOffsets: request.allocation.dynamicOffsets,
      deviceGeneration: request.allocation.deviceGeneration
    });
    bound.push(
      Object.freeze({
        item: Object.freeze({ ...request.item, bindingKey: bindingKey.hash }),
        bindingKey,
        diagnostics: Object.freeze([...resolution.diagnostics])
      })
    );
  }
  return Object.freeze({
    snapshot: buildRenderPhase(
      viewId,
      phase,
      bound.map(({ item }) => item)
    ),
    bound: Object.freeze(bound),
    skipped: Object.freeze(skipped)
  });
}

function validateContext(
  viewId: string,
  phase: RenderPhaseKind,
  requests: readonly MaterialBindingCompatibilityRequest[]
): void {
  if (typeof viewId !== 'string' || !viewId.trim())
    throw new Error('Material binding view ID must be non-empty.');
  const identities = new Set<string>();
  for (const request of requests) {
    if (request.item.phase !== phase) throw new Error('Material binding item phase mismatch.');
    if (request.item.bindingKey !== undefined)
      throw new Error('Material binding item must be unbound.');
    if (request.item.entity !== request.candidate.candidate.entity)
      throw new Error('Material binding candidate entity mismatch.');
    if (request.candidate.pipelineKey.parts.bindingLayoutHash !== request.layout.shaderLayoutHash)
      throw new Error('Material binding layout does not match the resolved pipeline.');
    if (request.bindingPlan.sourceLayoutHash !== request.layout.shaderLayoutHash)
      throw new Error('Material binding layout does not match the canonical binding plan.');
    const identity = `${request.item.entity}:${request.item.insertionOrder}`;
    if (identities.has(identity)) throw new Error('Duplicate Material binding item association.');
    identities.add(identity);
  }
}

function validateAllocation(
  request: MaterialBindingCompatibilityRequest
): MaterialBindingCompatibilitySkip | undefined {
  const { allocation } = request;
  const integers = [
    allocation.bufferAllocationGeneration,
    allocation.ringGeneration,
    allocation.deviceGeneration,
    ...allocation.dynamicOffsets
  ];
  if (integers.some((value) => !Number.isSafeInteger(value) || value < 0))
    return bindingSkip(request, 'binding-allocation-invalid', []);
  if (
    allocation.deviceGeneration !== request.resolver.deviceGeneration ||
    allocation.deviceGeneration !== request.candidate.pipelineKey.parts.deviceGeneration
  )
    return bindingSkip(request, 'binding-device-generation-stale', []);
  return undefined;
}

function skipCode(
  diagnostics: readonly { readonly code: string }[]
): MaterialBindingCompatibilitySkipCode {
  if (diagnostics.some(({ code }) => code === 'device-generation-mismatch'))
    return 'binding-device-generation-stale';
  if (diagnostics.some(({ code }) => code === 'resource-not-ready'))
    return 'binding-resource-not-ready';
  if (diagnostics.some(({ code }) => code === 'missing-resource'))
    return 'binding-resource-missing';
  return 'binding-layout-incompatible';
}

function bindingSkip(
  request: MaterialBindingCompatibilityRequest,
  code: MaterialBindingCompatibilitySkipCode,
  diagnostics: MaterialBindingCompatibilitySkip['diagnostics']
): MaterialBindingCompatibilitySkip {
  return Object.freeze({
    entity: request.item.entity,
    reason: 'incompatible-binding',
    code,
    diagnostics: Object.freeze([...diagnostics])
  });
}
