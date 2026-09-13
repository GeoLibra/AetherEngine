import type { RenderGraphSnapshot } from '../../builder/builder';
import type { GraphResourceRecord } from '../../builder/resources';
import type {
  BufferUsage,
  CompiledRenderGraph,
  ExternalResourceState,
  GraphResourceKind,
  PortableResourceUsage,
  PortableTransition,
  TextureUsage
} from '../../types';
import type { GraphRange } from '../../ranges';
import {
  atomizeTextureAspects,
  fullBufferRange,
  fullTextureRange,
  intersectGraphRanges,
  rangesOverlap,
  subtractGraphRange
} from '../../ranges';

export type { PortableResourceUsage, PortableTransition };

export interface PortableTransitionOptions {
  readonly submissionIndex?: number;
}

interface UsageRecord {
  readonly passId: number;
  readonly usage: PortableResourceUsage;
  readonly range: GraphRange;
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
