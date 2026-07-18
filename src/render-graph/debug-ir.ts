import type { RenderGraphSnapshot } from './builder';
import type { CompiledRenderGraph, CompiledRenderGraphEdge } from './compiler';
import {
  analyzeResourceLifetimes,
  derivePortableTransitions,
  planResourceAliases,
  type AliasDecision,
  type AliasPlanningOptions,
  type PortableTransition,
  type ResourceLifetime
} from './lifetimes';

export interface RenderGraphDebugIROptions extends AliasPlanningOptions {
  readonly submissionIndex?: number;
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
  readonly historyValid: boolean;
  readonly versions: readonly unknown[];
}

export interface RenderGraphDebugIR {
  readonly schemaVersion: 1;
  readonly passes: readonly RenderGraphDebugPass[];
  readonly resources: readonly RenderGraphDebugResource[];
  readonly edges: readonly CompiledRenderGraphEdge[];
  readonly order: readonly number[];
  readonly rootPassIds: readonly number[];
  readonly lifetimes: readonly ResourceLifetime[];
  readonly aliasDecisions: readonly AliasDecision[];
  readonly transitions: readonly PortableTransition[];
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
  const lifetimes = analyzeResourceLifetimes(snapshot, compiled);
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
  const resources = snapshot.resources.map((resource) =>
    Object.freeze({
      resourceId: resource.resourceId,
      kind: resource.kind,
      descriptor: resource.descriptor,
      origin: resource.origin,
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
  const edges = Object.freeze(compiled.edges.map((edge) => Object.freeze({ ...edge })));
  const order = Object.freeze([...compiled.order]);
  const rootPassIds = Object.freeze([...compiled.rootPassIds]);
  const logical = Object.freeze({
    schemaVersion: 1 as const,
    passes: Object.freeze(passes),
    resources: Object.freeze(resources),
    edges,
    order,
    rootPassIds,
    lifetimes,
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
      resources.length +
      resources.reduce((sum, resource) => sum + resource.versions.length, 0) +
      edges.length +
      lifetimes.length +
      aliasPlan.decisions.length +
      transitions.length
  });
  const withoutChecksum = Object.freeze({
    schemaVersion: 1 as const,
    passes: logical.passes,
    resources: logical.resources,
    edges,
    order,
    rootPassIds,
    lifetimes,
    aliasDecisions: aliasPlan.decisions,
    transitions,
    counters,
    logicalChecksum
  });
  return deepFreeze({ ...withoutChecksum, checksum: checksum(JSON.stringify(withoutChecksum)) });
}

export function toRenderGraphDebugJSON(plan: RenderGraphDebugIR): string {
  return JSON.stringify(plan);
}

function checksum(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function compactUndefined<T extends Readonly<Record<string, unknown>>>(value: T): T {
  return Object.freeze(
    Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined))
  ) as T;
}

function deepFreeze<T>(value: T, visited = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || visited.has(value)) return value;
  visited.add(value);
  for (const child of Object.values(value)) deepFreeze(child, visited);
  return Object.freeze(value);
}
