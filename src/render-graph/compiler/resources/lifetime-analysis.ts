import type {
  CompiledRenderGraph,
  GraphResourceKind,
  GraphResourceRecord,
  RasterGroupPlan,
  RenderGraphSnapshot,
  ResourceLifetime
} from '../../types';
import type { GraphRange } from '../../ranges';
import { fullBufferRange, fullTextureRange } from '../../ranges';
import { widenLifetimesForRasterGroups } from '../fusion/lifetime-widening';

interface MutableLifetime {
  readonly resourceId: number;
  readonly resourceKind: GraphResourceKind;
  firstUse: number;
  lastUse: number;
  firstPassId: number;
  lastPassId: number;
  readonly ranges: GraphRange[];
}

/** Computes physical-resource intervals after culling, in compiled schedule coordinates. */
export function analyzeResourceLifetimes(
  snapshot: RenderGraphSnapshot,
  compiled: CompiledRenderGraph,
  rasterGroups?: readonly RasterGroupPlan[]
): readonly ResourceLifetime[] {
  const byResource = new Map<number, MutableLifetime>();
  compiled.retainedPasses.forEach((pass, scheduleIndex) => {
    for (const access of pass.accesses) {
      recordLifetimeUse(
        byResource,
        access.handle.resourceId,
        access.handle.kind,
        access.range,
        pass.token.passId,
        scheduleIndex
      );
    }
    for (const terminal of pass.terminals) {
      const resource = requiredResource(snapshot, terminal.handle.resourceId);
      recordLifetimeUse(
        byResource,
        resource.resourceId,
        resource.kind,
        fullRange(resource),
        pass.token.passId,
        scheduleIndex
      );
    }
  });

  if (rasterGroups !== undefined && rasterGroups.length > 0) {
    widenLifetimesForRasterGroups(byResource, compiled, rasterGroups);
  }

  return Object.freeze(
    [...byResource.values()]
      .sort((first, second) => first.resourceId - second.resourceId)
      .map((lifetime) =>
        Object.freeze({
          resourceId: lifetime.resourceId,
          resourceKind: lifetime.resourceKind,
          firstUse: lifetime.firstUse,
          lastUse: lifetime.lastUse,
          firstPassId: lifetime.firstPassId,
          lastPassId: lifetime.lastPassId,
          ranges: Object.freeze(uniqueRanges(lifetime.ranges))
        })
      )
  );
}

function recordLifetimeUse(
  lifetimes: Map<number, MutableLifetime>,
  resourceId: number,
  resourceKind: GraphResourceKind,
  range: GraphRange,
  passId: number,
  scheduleIndex: number
): void {
  const current = lifetimes.get(resourceId);
  if (current === undefined) {
    lifetimes.set(resourceId, {
      resourceId,
      resourceKind,
      firstUse: scheduleIndex,
      lastUse: scheduleIndex,
      firstPassId: passId,
      lastPassId: passId,
      ranges: [range]
    });
    return;
  }
  current.lastUse = scheduleIndex;
  current.lastPassId = passId;
  current.ranges.push(range);
}

function fullRange(resource: GraphResourceRecord): GraphRange {
  return resource.kind === 'texture'
    ? fullTextureRange(resource.descriptor)
    : fullBufferRange(resource.descriptor);
}

function requiredResource(snapshot: RenderGraphSnapshot, resourceId: number): GraphResourceRecord {
  const resource = snapshot.resources[resourceId];
  if (resource === undefined)
    throw new Error(`Render graph references unknown resource ${resourceId}.`);
  return resource;
}

function uniqueRanges(ranges: readonly GraphRange[]): GraphRange[] {
  const seen = new Set<string>();
  return ranges.filter((range) => {
    const key = rangeKey(range);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rangeKey(range: GraphRange): string {
  if (range.kind === 'buffer') return `b:${range.offset}:${range.end}`;
  return `t:${range.baseMipLevel}:${range.mipLevelEnd}:${range.baseArrayLayer}:${range.arrayLayerEnd}:${range.aspect}`;
}
