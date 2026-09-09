import type { GraphPassDeclaration, RenderGraphSnapshot } from '../../builder/builder';
import type { GraphResourceRecord } from '../../builder/resources';
import type { CompiledRenderGraph, TextureDescriptor } from '../../types';
import { TEXTURE_FORMAT_BYTES } from './constants';

/**
 * Represents a resource lifetime interval for residency estimation.
 */
interface ResourceInterval {
  readonly resourceId: number;
  readonly size: number;
  startPassIndex: number;
  endPassIndex: number;
}

/**
 * Estimates the size of a single resource in bytes.
 * Returns null if the format or descriptor is not supported.
 */
export function estimateResourceSize(resource: GraphResourceRecord): number | null {
  if (resource.kind === 'buffer') {
    const desc = resource.descriptor as { size: number };
    return desc.size;
  }
  if (resource.kind === 'texture') {
    const desc = resource.descriptor as TextureDescriptor;
    const bpp = TEXTURE_FORMAT_BYTES[desc.format];
    if (bpp === null || bpp === undefined) return null;
    return mipTexelCount(desc) * (desc.depthOrArrayLayers ?? 1) * bpp * (desc.sampleCount ?? 1);
  }
  return null;
}

function mipTexelCount(desc: TextureDescriptor): number {
  let texels = 0;
  for (let mip = 0; mip < (desc.mipLevelCount ?? 1); mip++) {
    texels += Math.max(1, desc.width >> mip) * Math.max(1, desc.height >> mip);
  }
  return texels;
}

/**
 * Builds resource lifetime intervals for a sequence of passes.
 * Only transient resources are included in the calculation.
 */
function buildResourceIntervals(
  passes: readonly GraphPassDeclaration[],
  snapshot: RenderGraphSnapshot,
  compiled: CompiledRenderGraph
): ResourceInterval[] {
  const resourceMap = new Map(snapshot.resources.map((r) => [r.resourceId, r]));
  const passIndexMap = new Map(passes.map((p, idx) => [p.token.passId, idx]));
  const intervals: ResourceInterval[] = [];

  // Track first and last use of each transient resource
  const resourceUse = new Map<number, { first: number; last: number }>();

  for (let passIdx = 0; passIdx < passes.length; passIdx++) {
    const pass = passes[passIdx]!;
    for (const access of pass.accesses) {
      const resource = resourceMap.get(access.handle.resourceId);
      if (resource === undefined || resource.origin.kind !== 'transient') continue;

      const existing = resourceUse.get(resource.resourceId);
      if (existing === undefined) {
        resourceUse.set(resource.resourceId, { first: passIdx, last: passIdx });
      } else {
        existing.last = passIdx;
      }
    }
  }

  // Convert to intervals with size estimation
  for (const [resourceId, { first, last }] of resourceUse) {
    const resource = resourceMap.get(resourceId);
    if (resource === undefined) continue;

    const size = estimateResourceSize(resource);
    if (size === null) return []; // Cannot estimate, return empty to signal unavailable

    intervals.push(
      Object.freeze({
        resourceId,
        size,
        startPassIndex: first,
        endPassIndex: last
      })
    );
  }

  return intervals;
}

/**
 * Computes the peak live bytes at each pass boundary.
 * Returns the maximum peak across all boundaries.
 */
function computePeakLiveBytes(intervals: readonly ResourceInterval[]): number {
  if (intervals.length === 0) return 0;

  const maxPassIndex = Math.max(...intervals.map((i) => i.endPassIndex));
  let peak = 0;

  for (let passIdx = 0; passIdx <= maxPassIndex; passIdx++) {
    let liveBytes = 0;
    for (const interval of intervals) {
      if (interval.startPassIndex <= passIdx && passIdx <= interval.endPassIndex) {
        liveBytes += interval.size;
      }
    }
    peak = Math.max(peak, liveBytes);
  }

  return peak;
}

/**
 * Evaluates residency budget for merging a candidate pass into an existing group.
 * 
 * Returns:
 * - null if the merge is within budget
 * - 'residency-estimate-unavailable' if sizes cannot be estimated
 * - 'residency-budget' if the merge exceeds the budget
 * 
 * Algorithm per §13.8:
 * 1. Compute peak live transient bytes for merged group (existing + candidate)
 * 2. Compute peak live transient bytes for singleton execution (each pass independent)
 * 3. Calculate expansion = max(0, mergedPeak - singletonPeak)
 * 4. Reject if expansion > maxExpansionBytes
 */
export function evaluateResidencyBudget(
  existingMembers: readonly GraphPassDeclaration[],
  candidate: GraphPassDeclaration,
  snapshot: RenderGraphSnapshot,
  compiled: CompiledRenderGraph,
  maxExpansionBytes: number,
  acceptedGroups: readonly (readonly GraphPassDeclaration[])[] = []
): 'residency-budget' | 'residency-estimate-unavailable' | null {
  const schedule = compiled.retainedPasses;
  const singletonIntervals = buildResourceIntervals(schedule, snapshot, compiled);
  if (singletonIntervals.length === 0 && hasTransientResources(schedule, snapshot)) {
    return 'residency-estimate-unavailable';
  }
  const mergedIntervals = singletonIntervals.map((interval) => ({ ...interval }));
  const passIndices = new Map(schedule.map((pass, index) => [pass.token.passId, index]));
  for (const scope of [...acceptedGroups, [...existingMembers, candidate]]) {
    const indices = scope.map((pass) => passIndices.get(pass.token.passId)!);
    const scopeStart = Math.min(...indices);
    const scopeEnd = Math.max(...indices);
    const touched = new Set(
      scope.flatMap((pass) => pass.accesses.map((access) => access.handle.resourceId))
    );
    for (const interval of mergedIntervals) {
      if (!touched.has(interval.resourceId)) continue;
      interval.startPassIndex = Math.min(interval.startPassIndex, scopeStart);
      interval.endPassIndex = Math.max(interval.endPassIndex, scopeEnd);
    }
  }
  const mergedPeak = computePeakLiveBytes(mergedIntervals);
  const singletonPeak = computePeakLiveBytes(singletonIntervals);
  const expansion = Math.max(0, mergedPeak - singletonPeak);

  if (expansion > maxExpansionBytes) {
    return 'residency-budget';
  }

  return null;
}

/**
 * Checks if any of the passes use transient resources.
 */
function hasTransientResources(
  passes: readonly GraphPassDeclaration[],
  snapshot: RenderGraphSnapshot
): boolean {
  const resourceMap = new Map(snapshot.resources.map((r) => [r.resourceId, r]));
  for (const pass of passes) {
    for (const access of pass.accesses) {
      const resource = resourceMap.get(access.handle.resourceId);
      if (resource !== undefined && resource.origin.kind === 'transient') {
        return true;
      }
    }
  }
  return false;
}
