import type { RenderGraphSnapshot } from './builder';
import type { CompiledRenderGraph } from './compiler';
import {
  atomizeTextureAspects,
  fullBufferRange,
  fullTextureRange,
  intersectGraphRanges,
  rangesOverlap,
  subtractGraphRange,
  type GraphRange
} from './ranges';
import type { GraphResourceRecord } from './resources';
import type { BufferUsage, ExternalResourceState, GraphResourceKind, TextureUsage } from './types';

export interface ResourceLifetime {
  readonly resourceId: number;
  readonly resourceKind: GraphResourceKind;
  readonly firstUse: number;
  readonly lastUse: number;
  readonly firstPassId: number;
  readonly lastPassId: number;
  readonly ranges: readonly GraphRange[];
}

export type AliasRejectionReason =
  | 'overlapping-lifetime'
  | 'descriptor-incompatible'
  | 'origin-not-transient'
  | 'backend-alignment'
  | 'submission-pending';

export interface AliasRejection {
  readonly allocationId: number | null;
  readonly againstResourceId: number;
  readonly reason: AliasRejectionReason;
}

export interface AliasDecision {
  readonly resourceId: number;
  readonly allocationId: number | null;
  readonly aliasedWithResourceIds: readonly number[];
  readonly rejections: readonly AliasRejection[];
}

export interface ResourceAliasPlan {
  readonly decisions: readonly AliasDecision[];
  readonly allocationCount: number;
  readonly aliasGroupCount: number;
}

export interface AliasPlanningOptions {
  readonly aliasing?: boolean;
  readonly backendAlignments?: Readonly<Record<number, number>>;
  readonly submissionIndices?: Readonly<Record<number, number>>;
  readonly pendingResourceIds?: ReadonlySet<number>;
}

export type PortableResourceUsage = TextureUsage | BufferUsage | ExternalResourceState | 'present';

export interface PortableTransition {
  readonly resourceId: number;
  readonly resourceKind: GraphResourceKind;
  readonly range: GraphRange;
  readonly beforeUsage: PortableResourceUsage;
  readonly afterUsage: PortableResourceUsage;
  readonly fromPassId: number | null;
  readonly toPassId: number;
  readonly submissionIndex: number;
}

export interface PortableTransitionOptions {
  readonly submissionIndex?: number;
}

interface MutableLifetime {
  readonly resourceId: number;
  readonly resourceKind: GraphResourceKind;
  firstUse: number;
  lastUse: number;
  firstPassId: number;
  lastPassId: number;
  readonly ranges: GraphRange[];
}

interface AliasAllocation {
  readonly allocationId: number;
  readonly residents: ResourceLifetime[];
}

interface UsageRecord {
  readonly passId: number;
  readonly usage: PortableResourceUsage;
  readonly range: GraphRange;
}

/** Computes physical-resource intervals after culling, in compiled schedule coordinates. */
export function analyzeResourceLifetimes(
  snapshot: RenderGraphSnapshot,
  compiled: CompiledRenderGraph
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

/** Emits backend-neutral usage changes for retained accesses and terminal exports. */
export function derivePortableTransitions(
  snapshot: RenderGraphSnapshot,
  compiled: CompiledRenderGraph,
  options: PortableTransitionOptions = {}
): readonly PortableTransition[] {
  const submissionIndex = options.submissionIndex ?? 0;
  if (!Number.isSafeInteger(submissionIndex) || submissionIndex < 0) {
    throw new Error('Render graph submission index must be a non-negative integer.');
  }
  const history = new Map<number, UsageRecord[]>();
  const transitions: PortableTransition[] = [];

  for (const pass of compiled.retainedPasses) {
    for (const access of pass.accesses) {
      appendTransition(
        transitions,
        history,
        requiredResource(snapshot, access.handle.resourceId),
        access.range,
        access.usage,
        pass.token.passId,
        submissionIndex
      );
    }
    for (const terminal of pass.terminals) {
      const resource = requiredResource(snapshot, terminal.handle.resourceId);
      appendTransition(
        transitions,
        history,
        resource,
        fullRange(resource),
        terminal.kind === 'export' ? terminal.finalState : 'present',
        pass.token.passId,
        submissionIndex
      );
    }
  }
  return Object.freeze(transitions);
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

function appendTransition(
  transitions: PortableTransition[],
  history: Map<number, UsageRecord[]>,
  resource: GraphResourceRecord,
  range: GraphRange,
  usage: PortableResourceUsage,
  passId: number,
  submissionIndex: number
): void {
  const records = history.get(resource.resourceId) ?? [];
  for (const atom of transitionAtoms(range, resource)) {
    let uncovered: GraphRange[] = [atom];
    for (let index = records.length - 1; index >= 0 && uncovered.length > 0; index -= 1) {
      const previous = records[index] as UsageRecord;
      const next: GraphRange[] = [];
      for (const segment of uncovered) {
        if (!rangesOverlap(previous.range, segment)) {
          next.push(segment);
          continue;
        }
        const overlap = intersectGraphRanges(previous.range, segment);
        pushTransition(
          transitions,
          resource,
          overlap,
          previous.usage,
          usage,
          previous.passId,
          passId,
          submissionIndex
        );
        next.push(...subtractGraphRange(segment, overlap));
      }
      uncovered = next;
    }
    for (const segment of uncovered) {
      pushTransition(
        transitions,
        resource,
        segment,
        initialUsage(resource),
        usage,
        null,
        passId,
        submissionIndex
      );
    }
    records.push(Object.freeze({ passId, usage, range: atom }));
  }
  history.set(resource.resourceId, records);
}

function pushTransition(
  transitions: PortableTransition[],
  resource: GraphResourceRecord,
  range: GraphRange,
  beforeUsage: PortableResourceUsage,
  afterUsage: PortableResourceUsage,
  fromPassId: number | null,
  toPassId: number,
  submissionIndex: number
): void {
  if (beforeUsage === afterUsage) return;
  transitions.push(
    Object.freeze({
      resourceId: resource.resourceId,
      resourceKind: resource.kind,
      range,
      beforeUsage,
      afterUsage,
      fromPassId,
      toPassId,
      submissionIndex
    })
  );
}

function initialUsage(resource: GraphResourceRecord): PortableResourceUsage {
  return resource.origin.kind === 'imported' ? resource.origin.initialState : 'undefined';
}

function transitionAtoms(range: GraphRange, resource: GraphResourceRecord): GraphRange[] {
  return atomizeTextureAspects(
    range,
    resource.kind === 'texture' ? resource.descriptor.format : ''
  );
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
