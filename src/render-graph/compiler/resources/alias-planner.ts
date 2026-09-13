import type { RenderGraphSnapshot } from '../../builder/builder';
import type { GraphResourceRecord } from '../../builder/resources';
import type {
  AliasDecision,
  AliasRejection,
  AliasRejectionReason,
  ResourceAliasPlan,
  ResourceLifetime
} from '../../types';

export type {
  AliasDecision,
  AliasRejection,
  AliasRejectionReason,
  ResourceAliasPlan,
  ResourceLifetime
} from '../../types';

export interface AliasPlanningOptions {
  readonly aliasing?: boolean;
  readonly backendAlignments?: Readonly<Record<number, number>>;
  readonly submissionIndices?: Readonly<Record<number, number>>;
  readonly pendingResourceIds?: ReadonlySet<number>;
}

interface AliasAllocation {
  readonly allocationId: number;
  readonly residents: ResourceLifetime[];
}

/** Builds a stable first-fit alias plan without admitting imported/history resources. */
export function planResourceAliases(
  snapshot: RenderGraphSnapshot,
  lifetimes: readonly ResourceLifetime[],
  options: AliasPlanningOptions = {}
): ResourceAliasPlan {
  const allocations: AliasAllocation[] = [];
  const decisions: AliasDecision[] = [];
  const candidates = [...lifetimes].sort(
    (first, second) => first.firstUse - second.firstUse || first.resourceId - second.resourceId
  );

  for (const lifetime of candidates) {
    const resource = requiredResource(snapshot, lifetime.resourceId);
    const selfRejections = ineligibleResourceReasons(resource, lifetime, options);
    if (resource.origin.kind !== 'transient') {
      decisions.push(aliasDecision(lifetime, null, [], selfRejections));
      continue;
    }
    if (options.aliasing === false || selfRejections.length > 0) {
      const allocation = createAllocation(allocations, lifetime);
      decisions.push(aliasDecision(lifetime, allocation, [], selfRejections));
      continue;
    }

    const inspectedRejections: AliasRejection[] = [];
    let selected: AliasAllocation | undefined;
    for (const allocation of allocations) {
      const allocationRejections = allocation.residents.flatMap((resident) =>
        compatibilityRejections(snapshot, lifetime, resident, allocation.allocationId, options)
      );
      if (allocationRejections.length === 0) {
        selected = allocation;
        break;
      }
      inspectedRejections.push(...allocationRejections);
    }

    const allocation = selected ?? createAllocation(allocations, lifetime);
    const aliases = selected?.residents.map((resident) => resident.resourceId) ?? [];
    if (selected !== undefined) selected.residents.push(lifetime);
    decisions.push(aliasDecision(lifetime, allocation, aliases, inspectedRejections));
  }

  return Object.freeze({
    decisions: Object.freeze(decisions),
    allocationCount: allocations.length,
    aliasGroupCount: allocations.filter((allocation) => allocation.residents.length > 1).length
  });
}

function createAllocation(
  allocations: AliasAllocation[],
  lifetime: ResourceLifetime
): AliasAllocation {
  const allocation = { allocationId: allocations.length, residents: [lifetime] };
  allocations.push(allocation);
  return allocation;
}

function aliasDecision(
  lifetime: ResourceLifetime,
  allocation: AliasAllocation | null,
  aliases: readonly number[],
  rejections: readonly AliasRejection[]
): AliasDecision {
  return Object.freeze({
    resourceId: lifetime.resourceId,
    allocationId: allocation?.allocationId ?? null,
    aliasedWithResourceIds: Object.freeze([...aliases]),
    rejections: Object.freeze([...rejections])
  });
}

function ineligibleResourceReasons(
  resource: GraphResourceRecord,
  lifetime: ResourceLifetime,
  options: AliasPlanningOptions
): AliasRejection[] {
  const reasons: AliasRejection[] = [];
  if (resource.origin.kind !== 'transient') {
    reasons.push(rejection(null, lifetime.resourceId, 'origin-not-transient'));
  }
  if (options.pendingResourceIds?.has(lifetime.resourceId) === true) {
    reasons.push(rejection(null, lifetime.resourceId, 'submission-pending'));
  }
  return reasons;
}

function compatibilityRejections(
  snapshot: RenderGraphSnapshot,
  candidate: ResourceLifetime,
  resident: ResourceLifetime,
  allocationId: number,
  options: AliasPlanningOptions
): AliasRejection[] {
  const candidateResource = requiredResource(snapshot, candidate.resourceId);
  const residentResource = requiredResource(snapshot, resident.resourceId);
  const reasons: AliasRejection[] = [];
  if (!intervalsDisjoint(candidate, resident)) {
    reasons.push(rejection(allocationId, resident.resourceId, 'overlapping-lifetime'));
  }
  if (!descriptorsCompatible(candidateResource, residentResource)) {
    reasons.push(rejection(allocationId, resident.resourceId, 'descriptor-incompatible'));
  }
  if (
    candidateResource.origin.kind !== 'transient' ||
    residentResource.origin.kind !== 'transient'
  ) {
    reasons.push(rejection(allocationId, resident.resourceId, 'origin-not-transient'));
  }
  if (alignmentFor(candidate.resourceId, options) !== alignmentFor(resident.resourceId, options)) {
    reasons.push(rejection(allocationId, resident.resourceId, 'backend-alignment'));
  }
  if (
    options.pendingResourceIds?.has(candidate.resourceId) === true ||
    options.pendingResourceIds?.has(resident.resourceId) === true ||
    submissionFor(candidate.resourceId, options) !== submissionFor(resident.resourceId, options)
  ) {
    reasons.push(rejection(allocationId, resident.resourceId, 'submission-pending'));
  }
  return reasons;
}

function descriptorsCompatible(first: GraphResourceRecord, second: GraphResourceRecord): boolean {
  return descriptorKey(first) === descriptorKey(second);
}

function descriptorKey(resource: GraphResourceRecord): string {
  const usages = [...resource.descriptor.usage].sort().join(',');
  if (resource.kind === 'buffer') return `buffer:${resource.descriptor.size}:${usages}`;
  const descriptor = resource.descriptor;
  return `texture:${descriptor.width}:${descriptor.height}:${descriptor.depthOrArrayLayers}:${descriptor.mipLevelCount}:${descriptor.sampleCount}:${descriptor.format}:${usages}`;
}

function intervalsDisjoint(first: ResourceLifetime, second: ResourceLifetime): boolean {
  return first.lastUse < second.firstUse || second.lastUse < first.firstUse;
}

function rejection(
  allocationId: number | null,
  againstResourceId: number,
  reason: AliasRejectionReason
): AliasRejection {
  return Object.freeze({ allocationId, againstResourceId, reason });
}

function alignmentFor(resourceId: number, options: AliasPlanningOptions): number {
  return options.backendAlignments?.[resourceId] ?? 1;
}

function submissionFor(resourceId: number, options: AliasPlanningOptions): number {
  return options.submissionIndices?.[resourceId] ?? 0;
}

function requiredResource(snapshot: RenderGraphSnapshot, resourceId: number): GraphResourceRecord {
  const resource = snapshot.resources[resourceId];
  if (resource === undefined)
    throw new Error(`Render graph references unknown resource ${resourceId}.`);
  return resource;
}
