import type { RHIBuffer, RHITexture } from '../../rhi/contracts';
import type { GraphAccess } from '../builder/builder';
import { containsRange, normalizeRequestedRange } from '../executor/executor-resource-utils';
import type { GraphRange } from '../ranges';
import type { GraphResourceRecord } from '../builder/resources';
import type { BufferRange, BufferUsage, GraphHandle, TextureRange, TextureUsage } from '../types';

export function resolveDeclaredResource(
  accesses: readonly GraphAccess[],
  resources: ReadonlyMap<GraphHandle, RHITexture | RHIBuffer>,
  resourceRecords: ReadonlyMap<number, GraphResourceRecord>,
  handle: GraphHandle,
  usage: TextureUsage | BufferUsage,
  requestedRange: TextureRange | BufferRange | undefined
): { readonly resource: RHITexture | RHIBuffer; readonly range: GraphRange } {
  const candidates = accesses.filter(
    (candidate) => candidate.handle === handle && candidate.usage === usage
  );
  if (candidates.length === 0) {
    const declared = accesses.some((candidate) => candidate.handle === handle);
    throw new Error(
      declared
        ? `Render graph resource usage "${usage}" is not declared for this pass.`
        : 'Render graph resource is not declared for this pass.'
    );
  }
  const record = resourceRecords.get(handle.resourceId);
  if (record === undefined)
    throw new Error(`Render graph resource ${handle.resourceId} has no descriptor.`);
  const range =
    requestedRange === undefined
      ? candidates.length === 1
        ? candidates[0]!.range
        : undefined
      : normalizeRequestedRange(handle, requestedRange, record.descriptor);
  if (range === undefined) {
    throw new Error(
      'Render graph resource has multiple declarations; an explicit range is required.'
    );
  }
  if (!candidates.some((candidate) => containsRange(candidate.range, range))) {
    throw new Error('Render graph resource range is outside this pass declaration.');
  }
  const resource = resources.get(handle);
  if (resource === undefined) {
    throw new Error(
      `Render graph resource ${handle.resourceId} version ${handle.version} has no physical binding.`
    );
  }
  return { resource, range };
}
