import { fnv1a32Hex } from '../../core';
import type { RenderGraphSnapshot } from '../builder/builder';
import type {
  CompiledRenderGraph,
  CompiledRenderGraphEdge,
  GroupPartitionResult,
  RasterGroupPlan
} from '../types';
import { createRenderGraphExecutionSchedule } from '../executor/execution-plan';
import type { RenderGraphExecutionStep } from '../types';
import {
  analyzeResourceLifetimes,
  derivePortableTransitions,
  planResourceAliases,
  type AliasDecision,
  type AliasPlanningOptions,
  type PortableTransition,
  type ResourceLifetime
} from './lifetimes';
import type { HistoryInvalidationReason, HistorySlotDebugState } from './history';

const HISTORY_INVALIDATION_REASONS = new Set<HistoryInvalidationReason>([
  'new',
  'generation-changed',
  'resize',
  'abi-changed',
  'policy-changed',
  'explicit-reset',
  'view-destroyed',
  'submission-failed',
  'device-lost'
]);

export interface RenderGraphHistoryDebugBinding {
  readonly readableSlot: number | undefined;
  readonly writableSlot: number;
  readonly versionSlots: readonly {
    readonly version: number;
    readonly slot: number | undefined;
  }[];
  readonly slots: readonly HistorySlotDebugState[];
}

export interface RenderGraphDebugIROptions extends AliasPlanningOptions {
  readonly submissionIndex?: number;
  readonly schedule?: readonly RenderGraphExecutionStep[];
  readonly historyStates?: ReadonlyMap<number, RenderGraphHistoryDebugBinding>;
  /** Physical raster grouping produced for this exact compiled graph. */
  readonly fusion?: GroupPartitionResult;
}

/** Serializable evidence for compiler-selected physical raster grouping. */
export interface RenderGraphDebugFusion {
  readonly groups: readonly RenderGraphDebugRasterGroup[];
  readonly splitRecords: GroupPartitionResult['splitRecords'];
  readonly counters: GroupPartitionResult['counters'];
}

/** Serializable representation of one physical raster pass and its logical members. */
export interface RenderGraphDebugRasterGroup {
  readonly groupIndex: number;
  readonly retainedPassIndices: readonly number[];
  readonly passIds: readonly number[];
  readonly attachments: RasterGroupPlan['attachments'];
  readonly usageScope: {
    readonly textures: readonly { readonly resourceId: number; readonly usages: readonly string[] }[];
    readonly buffers: readonly { readonly resourceId: number; readonly usages: readonly string[] }[];
  };
  readonly boundaryStates: RasterGroupPlan['boundaryStates'];
}

export interface RenderGraphDebugPass {
  readonly passId: number;
  readonly id: string;
  readonly registrationIndex: number;
  readonly retained: boolean;
  readonly cullReason?: 'unreachable-from-root';
  readonly sideEffects: readonly string[];
}

export interface RenderGraphDebugResource {
  readonly resourceId: number;
  readonly kind: 'texture' | 'buffer';
  readonly descriptor: unknown;
  readonly origin: unknown;
  readonly disposition: 'internal' | 'exported' | 'present';
  readonly historyValid: boolean;
  readonly versions: readonly unknown[];
  readonly history?: RenderGraphHistoryDebugBinding;
}

export interface RenderGraphDebugIR {
  readonly schemaVersion: 1;
  readonly passes: readonly RenderGraphDebugPass[];
  readonly resources: readonly RenderGraphDebugResource[];
  readonly edges: readonly CompiledRenderGraphEdge[];
  readonly order: readonly number[];
  readonly rootPassIds: readonly number[];
  readonly schedule: readonly RenderGraphExecutionStep[];
  readonly lifetimes: readonly ResourceLifetime[];
  readonly aliasDecisions: readonly AliasDecision[];
  readonly transitions: readonly PortableTransition[];
  readonly fusion?: RenderGraphDebugFusion;
  readonly counters: CompiledRenderGraph['counters'] & {
    readonly aliasGroups: number;
    readonly allocations: number;
    readonly temporaryIrObjects: number;
  };
  readonly logicalChecksum: string;
  readonly checksum: string;
}

/** Creates stable, native-object-free compiler evidence suitable for capture and diffing. */
export function createRenderGraphDebugIR(
  snapshot: RenderGraphSnapshot,
  compiled: CompiledRenderGraph,
  options: RenderGraphDebugIROptions = {}
): RenderGraphDebugIR {
  const logicalLifetimes = analyzeResourceLifetimes(snapshot, compiled);
  const lifetimes =
    options.fusion === undefined
      ? logicalLifetimes
      : analyzeResourceLifetimes(snapshot, compiled, options.fusion.groups);
  const aliasPlan = planResourceAliases(snapshot, lifetimes, options);
  const transitions = derivePortableTransitions(snapshot, compiled, {
    submissionIndex: options.submissionIndex ?? 0
  });
  const retained = new Set(compiled.order);
  const cullReasons = new Map(compiled.culledPasses.map((pass) => [pass.passId, pass.reason]));
  const passes: RenderGraphDebugPass[] = snapshot.passes.map((pass) => {
    const cullReason = cullReasons.get(pass.token.passId);
    return Object.freeze({
      passId: pass.token.passId,
      id: pass.id,
      registrationIndex: pass.registrationIndex,
      retained: retained.has(pass.token.passId),
      ...(cullReason === undefined ? {} : { cullReason }),
      sideEffects: Object.freeze([...pass.sideEffects])
    });
  });
  const logicalResources = snapshot.resources.map((resource) =>
    Object.freeze({
      resourceId: resource.resourceId,
      kind: resource.kind,
      descriptor: resource.descriptor,
      origin: resource.origin,
      disposition: dispositionFor(snapshot, resource.resourceId),
      historyValid: resource.historyValid,
      versions: Object.freeze(
        resource.versions.map((version) =>
          compactUndefined(
            Object.freeze({
              version: version.version,
              parentVersion: version.parentVersion,
              producerPassId: version.producerPassId,
              writeRange: version.writeRange,
              initialized: version.initialized
            })
          )
        )
      )
    })
  );
  const resources: RenderGraphDebugResource[] = logicalResources.map((resource) => {
    const history = options.historyStates?.get(resource.resourceId);
    return Object.freeze({
      ...resource,
      ...(history === undefined ? {} : { history: cloneHistoryDebugBinding(history) })
    });
  });
  const edges = Object.freeze(compiled.edges.map((edge) => Object.freeze({ ...edge })));
  const order = Object.freeze([...compiled.order]);
  const rootPassIds = Object.freeze([...compiled.rootPassIds]);
  const schedule = cloneDebugSchedule(
    options.schedule ?? createRenderGraphExecutionSchedule(compiled)
  );
  const fusion = options.fusion === undefined ? undefined : cloneDebugFusion(options.fusion);
  const logical = Object.freeze({
    schemaVersion: 1 as const,
    passes: Object.freeze(passes),
    resources: Object.freeze(logicalResources),
    edges,
    order,
    rootPassIds,
    schedule,
    lifetimes: logicalLifetimes,
    transitions,
    compilerCounters: compiled.counters
  });
  const logicalChecksum = checksum(JSON.stringify(logical));
  const counters = Object.freeze({
    ...compiled.counters,
    aliasGroups: aliasPlan.aliasGroupCount,
    allocations: aliasPlan.allocationCount,
    temporaryIrObjects:
      passes.length +
      logicalResources.length +
      logicalResources.reduce((sum, resource) => sum + resource.versions.length, 0) +
      edges.length +
      lifetimes.length +
      aliasPlan.decisions.length +
      transitions.length +
      schedule.length
  });
  const withoutChecksum = Object.freeze({
    schemaVersion: 1 as const,
    passes: logical.passes,
    resources: Object.freeze(resources),
    edges,
    order,
    rootPassIds,
    schedule,
    lifetimes,
    aliasDecisions: aliasPlan.decisions,
    transitions,
    ...(fusion === undefined ? {} : { fusion }),
    counters,
    logicalChecksum
  });
  return deepFreeze({ ...withoutChecksum, checksum: checksum(JSON.stringify(withoutChecksum)) });
}

function cloneDebugFusion(fusion: GroupPartitionResult): RenderGraphDebugFusion {
  return Object.freeze({
    groups: Object.freeze(fusion.groups.map(cloneDebugRasterGroup)),
    splitRecords: Object.freeze(
      fusion.splitRecords.map((record) =>
        Object.freeze({
          predecessorPassId: record.predecessorPassId,
          candidatePassId: record.candidatePassId,
          reason: record.reason,
          ...(record.detail === undefined ? {} : { detail: record.detail })
        })
      )
    ),
    counters: Object.freeze({ ...fusion.counters })
  });
}

function cloneDebugRasterGroup(group: RasterGroupPlan): RenderGraphDebugRasterGroup {
  return Object.freeze({
    groupIndex: group.groupIndex,
    retainedPassIndices: Object.freeze([...group.retainedPassIndices]),
    passIds: Object.freeze([...group.passIds]),
    attachments: Object.freeze({
      colorAttachments: Object.freeze(
        group.attachments.colorAttachments.map((attachment) => Object.freeze({ ...attachment }))
      ),
      ...(group.attachments.depthStencilAttachment === undefined
        ? {}
        : { depthStencilAttachment: Object.freeze({ ...group.attachments.depthStencilAttachment }) })
    }),
    usageScope: Object.freeze({
      textures: cloneUsageScope(group.usageScope.textures),
      buffers: cloneUsageScope(group.usageScope.buffers)
    }),
    boundaryStates: Object.freeze(group.boundaryStates.map((state) => Object.freeze({ ...state })))
  });
}

function cloneUsageScope(
  values: ReadonlyMap<number, readonly string[]>
): readonly { readonly resourceId: number; readonly usages: readonly string[] }[] {
  return Object.freeze(
    [...values.entries()]
      .sort(([first], [second]) => first - second)
      .map(([resourceId, usages]) =>
        Object.freeze({ resourceId, usages: Object.freeze([...usages]) })
      )
  );
}

export function toRenderGraphDebugJSON(plan: RenderGraphDebugIR): string {
  return JSON.stringify(plan);
}

function dispositionFor(
  snapshot: RenderGraphSnapshot,
  resourceId: number
): RenderGraphDebugResource['disposition'] {
  const terminal = snapshot.terminals.find(
    (candidate) => candidate.handle.resourceId === resourceId
  );
  if (terminal === undefined) return 'internal';
  return terminal.kind === 'present' ? 'present' : 'exported';
}

function checksum(value: string): string {
  return fnv1a32Hex(value);
}

function compactUndefined<T extends Readonly<Record<string, unknown>>>(value: T): T {
  return Object.freeze(
    Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
  ) as T;
}

function cloneHistoryDebugBinding(history: unknown): RenderGraphHistoryDebugBinding {
  const record = requireDebugRecord(history, 'history debug binding');
  return {
    readableSlot: optionalDebugNumber(record.readableSlot, 'history readable slot'),
    writableSlot: requiredDebugNumber(record.writableSlot, 'history writable slot'),
    versionSlots: requiredDebugArray(record.versionSlots, 'history version slots').map((slot) => {
      const version = requireDebugRecord(slot, 'history version slot');
      return {
        version: requiredDebugNumber(version.version, 'history version'),
        slot: optionalDebugNumber(version.slot, 'history version slot')
      };
    }),
    slots: requiredDebugArray(record.slots, 'history slots').map((slot) =>
      cloneHistorySlotDebugState(slot)
    )
  };
}

function cloneHistorySlotDebugState(value: unknown): HistorySlotDebugState {
  const slot = requireDebugRecord(value, 'history slot');
  const invalidationReason = slot.invalidationReason as unknown;
  if (
    invalidationReason !== undefined &&
    (typeof invalidationReason !== 'string' ||
      !HISTORY_INVALIDATION_REASONS.has(invalidationReason as HistoryInvalidationReason))
  ) {
    throw new Error('Render graph history invalidation reason is invalid.');
  }
  return {
    slot: requiredDebugNumber(slot.slot, 'history slot index'),
    valid: requiredDebugBoolean(slot.valid, 'history slot validity'),
    invalidationReason: invalidationReason as HistoryInvalidationReason | undefined,
    producerSubmissionId: optionalDebugNumber(
      slot.producerSubmissionId,
      'history producer submission id'
    ),
    pendingSubmissionIds: requiredDebugArray(
      slot.pendingSubmissionIds,
      'pending submission ids'
    ).map((id) => requiredDebugNumber(id, 'pending submission id')),
    pendingRetirement: requiredDebugBoolean(slot.pendingRetirement, 'history pending retirement')
  };
}

function cloneDebugSchedule(value: unknown): readonly RenderGraphExecutionStep[] {
  const steps: RenderGraphExecutionStep[] = [];
  for (const step of requiredDebugArray(value, 'render graph debug schedule')) {
    const record = requireDebugRecord(step, 'render graph debug schedule step');
    if (record.kind === 'prelude') {
      steps.push({ kind: 'prelude' });
      continue;
    }
    if (record.kind === 'submission') {
      steps.push({ kind: 'submission' });
      continue;
    }
    if (record.kind === 'pass') {
      steps.push({
        kind: 'pass',
        passId: requiredDebugNumber(record.passId, 'render graph debug pass id'),
        retainedPassIndex: requiredDebugNumber(
          record.retainedPassIndex,
          'render graph debug retained pass index'
        )
      });
      continue;
    }
    if (record.kind === 'raster-group') {
      steps.push({
        kind: 'raster-group',
        groupIndex: requiredDebugNumber(record.groupIndex, 'render graph debug group index')
      });
      continue;
    }
    throw new Error('Render graph debug schedule step kind is invalid.');
  }
  return Object.freeze(steps);
}

function requireDebugRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Render graph ${label} must be a record.`);
  }
  return value as Record<string, unknown>;
}

function requiredDebugArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`Render graph ${label} must be an array.`);
  return value;
}

function requiredDebugNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Render graph ${label} must be a finite number.`);
  }
  return value;
}

function optionalDebugNumber(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : requiredDebugNumber(value, label);
}

function requiredDebugBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Render graph ${label} must be a boolean.`);
  return value;
}

function deepFreeze<T>(value: T, visited = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || visited.has(value)) return value;
  visited.add(value);
  for (const child of Object.values(value)) deepFreeze(child, visited);
  return Object.freeze(value);
}
