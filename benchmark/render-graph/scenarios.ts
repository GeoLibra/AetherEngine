import { createRenderGraphWorkload } from './fixtures';
import { runReferenceRenderGraph } from './reference';
import type {
  RenderGraphReferenceResult,
  RenderGraphScenario,
  RenderGraphWorkload,
  RenderGraphWorkloadOptions
} from './types';
import { RenderGraphBuilder } from '../../src/render-graph/builder';
import { compileRenderGraph, createRenderGraphDebugIR } from '../../src/render-graph/compiler';
import {
  RenderGraphExecutor,
  createRenderGraphExecutionPlan,
  TransientResourcePool
} from '../../src/render-graph/executor';
import { NullDevice } from '../../src/rhi/null/device';
import type {
  BufferHandle,
  GraphHandle,
  RestrictedPassContext
} from '../../src/render-graph/types';
import type { RHIBuffer } from '../../src/rhi/contracts';

export interface RenderGraphCompilerSemantic {
  readonly orderChecksum: string;
  readonly edgeChecksum: string;
  readonly cullChecksum: string;
  readonly lifetimeChecksum: string;
  readonly retainedPasses: number;
  readonly culledPasses: number;
  readonly aliasChecksumEquivalent: boolean;
}

export interface RenderGraphCompilerCounters {
  readonly passesVisited: number;
  readonly accessesExamined: number;
  readonly overlapComparisons: number;
  readonly adjacencyEntries: number;
  readonly readyOperations: number;
  readonly temporaryIrObjects: number;
  readonly aliasGroups: number;
  readonly allocations: number;
  readonly wholeResourceFallbacks: number;
  /** Actual executor work: one boundary step per plan entry, not a per-pass graph scan. */
  readonly executionSteps: number;
  readonly passResolutions: number;
  readonly versionCount: number;
  readonly transitionCount: number;
  readonly submissionCount: number;
  readonly commandCount: number;
  readonly subresourceKeyCount: number;
  readonly physicalAllocationCount: number;
}

export interface RenderGraphPhaseObservation {
  readonly checksum: string;
  readonly counters: Readonly<Record<string, number>>;
}

export interface RenderGraphCompilerObservation {
  readonly semantic: RenderGraphCompilerSemantic;
  readonly counters: RenderGraphCompilerCounters;
}

export interface RenderGraphCompilerScenario {
  readonly scenarioId: 'hazard-compile-v1';
  readonly scenarioVersion: 1;
  readonly workload: RenderGraphWorkload;
  runReference(): RenderGraphCompilerObservation;
  runSubject(): RenderGraphCompilerObservation;
  runSubjectCompilePhase(): RenderGraphPhaseObservation;
  runSubjectExecutePhase(): RenderGraphPhaseObservation;
}

export function probeSubmissionSafety(): Readonly<{
  pendingSubmissionAttempts: number;
  prematureReuseCount: number;
}> {
  const device = new NullDevice({ submissionMode: 'manual' });
  const pool = new TransientResourcePool(device);
  const descriptor = Object.freeze({
    kind: 'buffer' as const,
    descriptor: Object.freeze({ size: 64, usage: 1 })
  });
  const retained = pool.acquire(descriptor);
  const pendingSubmission = device.queue.submit([]);
  pool.release(retained, pendingSubmission);
  const candidate = pool.acquire(descriptor);
  const prematureReuseCount = candidate === retained ? 1 : 0;
  pool.release(candidate);
  pool.dispose();
  if (prematureReuseCount !== 0) {
    throw new Error('RenderGraph transient pool reused a resource before submission completion.');
  }
  return Object.freeze({ pendingSubmissionAttempts: 1, prematureReuseCount });
}

export function createReferenceRenderGraphScenario(
  options: RenderGraphWorkloadOptions
): RenderGraphScenario {
  const workload = createRenderGraphWorkload(options);
  return Object.freeze({
    scenarioId: 'hazard-compile-v1',
    scenarioVersion: 1,
    workload,
    runReference: () => runReferenceRenderGraph(workload)
  });
}

export function createRenderGraphCompilerScenario(
  options: RenderGraphWorkloadOptions
): RenderGraphCompilerScenario {
  const workload = createRenderGraphWorkload(options);
  const executionFixture = compileSubjectFixture(workload);
  return Object.freeze({
    scenarioId: 'hazard-compile-v1' as const,
    scenarioVersion: 1 as const,
    workload,
    runReference: () => referenceObservation(workload, runReferenceRenderGraph(workload)),
    runSubject: () => subjectObservation(workload),
    runSubjectCompilePhase: () => compilePhaseObservation(workload),
    runSubjectExecutePhase: () => executePhaseObservation(executionFixture)
  });
}

export function assertRenderGraphScenarioComparison(
  scenario: RenderGraphCompilerScenario,
  reference: RenderGraphCompilerObservation,
  subject: RenderGraphCompilerObservation
): void {
  if (JSON.stringify(reference.semantic) !== JSON.stringify(subject.semantic)) {
    throw new Error(
      `RenderGraph semantic oracle mismatch for ${scenario.scenarioId}: ${JSON.stringify(reference.semantic)} !== ${JSON.stringify(subject.semantic)}.`
    );
  }
  const expectedAccesses = scenario.workload.passes.length * scenario.workload.accessesPerPass;
  if (subject.counters.passesVisited !== scenario.workload.passes.length) {
    throw new Error('RenderGraph subject did not visit the closed-form pass count.');
  }
  if (subject.counters.accessesExamined !== expectedAccesses) {
    throw new Error('RenderGraph subject did not examine the closed-form access count.');
  }
  if (subject.counters.readyOperations !== scenario.workload.passes.length * 2) {
    throw new Error('RenderGraph subject ready-queue operations diverged from the retained DAG.');
  }
  if (subject.counters.wholeResourceFallbacks !== 0) {
    throw new Error(
      'RenderGraph benchmark uses exact ranges and must not fall back to whole resources.'
    );
  }
  if (subject.counters.executionSteps !== scenario.workload.passes.length + 2) {
    throw new Error('RenderGraph executor did not visit the closed-form schedule length.');
  }
  if (subject.counters.passResolutions !== scenario.workload.passes.length) {
    throw new Error('RenderGraph executor did not resolve each retained pass exactly once.');
  }
}

function referenceObservation(
  workload: RenderGraphWorkload,
  result: RenderGraphReferenceResult
): RenderGraphCompilerObservation {
  return Object.freeze({
    semantic: Object.freeze({
      orderChecksum: integerListChecksum(result.order),
      edgeChecksum: result.edgeChecksum,
      cullChecksum: textChecksum(''),
      lifetimeChecksum: referenceLifetimeChecksum(workload),
      retainedPasses: result.retainedPasses,
      culledPasses: 0,
      aliasChecksumEquivalent: true
    }),
    counters: Object.freeze({
      passesVisited: workload.passes.length,
      accessesExamined: result.accessesExamined,
      overlapComparisons: result.overlapComparisons,
      adjacencyEntries: referenceRelationshipCount(workload),
      readyOperations: workload.passes.length * 2,
      temporaryIrObjects: 0,
      aliasGroups: 0,
      allocations: 0,
      wholeResourceFallbacks: 0,
      executionSteps: workload.passes.length + 2,
      passResolutions: workload.passes.length,
      versionCount: workload.options.resourceCount,
      transitionCount: 0,
      submissionCount: 1,
      commandCount: workload.passes.length * 2,
      subresourceKeyCount: workload.options.resourceCount,
      physicalAllocationCount: 0
    })
  });
}

function subjectObservation(workload: RenderGraphWorkload): RenderGraphCompilerObservation {
  const { snapshot, compiled } = compileSubjectFixture(workload);
  const executed = executeCompiledFixture(snapshot, compiled);
  const execution = executed.execution;
  const debug = execution.debug;
  const noAliasDebug = createRenderGraphDebugIR(snapshot, compiled, { aliasing: false });
  const relationships = uniqueRelationships(compiled.edges);
  const oracleRelationships = referenceRelationships(workload);
  const equivalentEdges = equivalentReachability(
    workload.passes.length,
    oracleRelationships,
    relationships
  );
  return Object.freeze({
    semantic: Object.freeze({
      orderChecksum: integerListChecksum(compiled.order),
      edgeChecksum: equivalentEdges
        ? relationshipChecksum(oracleRelationships)
        : textChecksum(
            `invalid:${relationshipChecksum(reachability(workload.passes.length, relationships))}`
          ),
      cullChecksum: integerListChecksum(compiled.culledPasses.map((pass) => pass.passId)),
      lifetimeChecksum: lifetimeChecksum(debug.lifetimes),
      retainedPasses: compiled.retainedPasses.length,
      culledPasses: compiled.culledPasses.length,
      aliasChecksumEquivalent: debug.logicalChecksum === noAliasDebug.logicalChecksum
    }),
    counters: Object.freeze({
      passesVisited: snapshot.passes.length,
      accessesExamined: compiled.counters.accessesExamined,
      overlapComparisons: compiled.counters.overlapComparisons,
      adjacencyEntries: relationships.length,
      readyOperations: compiled.order.length * 2,
      temporaryIrObjects: debug.counters.temporaryIrObjects,
      aliasGroups: debug.counters.aliasGroups,
      allocations: debug.counters.allocations,
      wholeResourceFallbacks: compiled.counters.wholeResourceFallbacks,
      executionSteps: execution.executionCounters.scheduledSteps,
      passResolutions: execution.executionCounters.passResolutions,
      versionCount: snapshot.resources.reduce((sum, resource) => sum + resource.versions.length, 0),
      transitionCount: debug.transitions.length,
      submissionCount: execution.submission.id > 0 ? 1 : 0,
      commandCount: execution.commandBuffer.getCommandStream().length,
      subresourceKeyCount: new Set(
        snapshot.passes.flatMap((pass) =>
          pass.accesses.map((access) => JSON.stringify(access.range))
        )
      ).size,
      physicalAllocationCount: executed.physicalAcquisitions
    })
  });
}

function compileSubjectFixture(workload: RenderGraphWorkload) {
  const graph = new RenderGraphBuilder();
  const handles: BufferHandle[] = Array.from(
    { length: workload.options.resourceCount },
    (_, index) => {
      const firstAccess = workload.passes
        .flatMap((pass) => pass.accesses)
        .find((access) => access.resourceIndex === index);
      return graph.createBuffer(
        {
          label: `benchmark-resource-${index}`,
          size: 256,
          usage: Object.freeze(['storage-read', 'storage-write'])
        },
        firstAccess?.mode === 'write'
          ? { origin: { kind: 'transient' } }
          : {
              origin: {
                kind: 'imported',
                initialState: 'storage-read',
                acquire: { kind: 'external-acquire', id: `benchmark-resource-${index}` }
              }
            }
      );
    }
  );
  for (const passWorkload of workload.passes) {
    graph.addPass({
      id: `benchmark-pass-${passWorkload.registrationIndex}`,
      setup(pass) {
        for (const access of passWorkload.accesses) {
          const handle = handles[access.resourceIndex];
          if (handle === undefined)
            throw new Error('RenderGraph subject fixture handle is missing.');
          if (access.mode === 'read') pass.readBuffer(handle, 'storage-read');
          else handles[access.resourceIndex] = pass.writeBuffer(handle, 'storage-write');
        }
        pass.sideEffect(`benchmark-pass-${passWorkload.registrationIndex}`);
        return undefined;
      },
      run(context: RestrictedPassContext) {
        context.beginCompute({ label: `benchmark-pass-${passWorkload.registrationIndex}` }).end();
      }
    });
  }
  const snapshot = graph.build();
  const compiled = compileRenderGraph(snapshot);
  return Object.freeze({ snapshot, compiled });
}

function compilePhaseObservation(workload: RenderGraphWorkload): RenderGraphPhaseObservation {
  const { snapshot, compiled } = compileSubjectFixture(workload);
  const debug = createRenderGraphDebugIR(snapshot, compiled);
  return Object.freeze({
    checksum: debug.logicalChecksum,
    counters: Object.freeze({
      passes: compiled.retainedPasses.length,
      edges: compiled.edges.length,
      transitions: debug.transitions.length,
      versions: snapshot.resources.reduce((sum, resource) => sum + resource.versions.length, 0)
    })
  });
}

function executePhaseObservation(
  fixture: ReturnType<typeof compileSubjectFixture>
): RenderGraphPhaseObservation {
  const executed = executeCompiledFixture(fixture.snapshot, fixture.compiled);
  return Object.freeze({
    checksum: textChecksum(JSON.stringify(executed.execution.commandBuffer.getCommandStream())),
    counters: Object.freeze({
      submissions: 1,
      commands: executed.execution.commandBuffer.getCommandStream().length,
      physicalAllocations: executed.physicalAcquisitions,
      scheduledSteps: executed.execution.executionCounters.scheduledSteps
    })
  });
}

function executeCompiledFixture(
  snapshot: ReturnType<RenderGraphBuilder['build']>,
  compiled: ReturnType<typeof compileRenderGraph>
) {
  const device = new NullDevice();
  let physicalAcquisitions = 0;
  class CountingPool extends TransientResourcePool {
    override acquire(descriptor: Parameters<TransientResourcePool['acquire']>[0]) {
      physicalAcquisitions += 1;
      return super.acquire(descriptor);
    }
  }
  const pool = new CountingPool(device);
  const imported = new Map<GraphHandle, RHIBuffer>();
  for (const resource of snapshot.resources) {
    if (resource.origin.kind === 'transient') continue;
    const handle = resource.versions[0]?.handle;
    if (handle === undefined || resource.kind !== 'buffer') {
      throw new Error('RenderGraph benchmark executor fixture requires an imported buffer handle.');
    }
    imported.set(handle, device.createBuffer({ size: resource.descriptor.size, usage: 128 }));
  }
  const execution = new RenderGraphExecutor().execute(
    createRenderGraphExecutionPlan(snapshot, compiled),
    {
      device,
      resources: imported,
      transientPool: pool
    }
  );
  return Object.freeze({ execution, physicalAcquisitions });
}

function referenceLifetimeChecksum(workload: RenderGraphWorkload): string {
  const intervals = Array.from({ length: workload.options.resourceCount }, (_, resourceId) => {
    const uses = workload.passes
      .filter((pass) => pass.accesses.some((access) => access.resourceIndex === resourceId))
      .map((pass) => pass.registrationIndex);
    return uses.length === 0
      ? undefined
      : `${resourceId}:${uses[0] as number}:${uses[uses.length - 1] as number};`;
  }).filter((value): value is string => value !== undefined);
  return textChecksum(intervals.join(''));
}

function lifetimeChecksum(
  lifetimes: readonly {
    readonly resourceId: number;
    readonly firstUse: number;
    readonly lastUse: number;
  }[]
): string {
  return textChecksum(
    lifetimes
      .map((lifetime) => `${lifetime.resourceId}:${lifetime.firstUse}:${lifetime.lastUse};`)
      .join('')
  );
}

type Relationship = readonly [number, number];

function uniqueRelationships(
  edges: readonly { readonly fromPassId: number; readonly toPassId: number }[]
): readonly Relationship[] {
  const seen = new Set<string>();
  return Object.freeze(
    edges
      .map((edge) => Object.freeze([edge.fromPassId, edge.toPassId] as const))
      .filter(([from, to]) => {
        const key = `${from}:${to}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .sort(
        ([firstFrom, firstTo], [secondFrom, secondTo]) =>
          firstFrom - secondFrom || firstTo - secondTo
      )
  );
}

function referenceRelationshipCount(workload: RenderGraphWorkload): number {
  return referenceRelationships(workload).length;
}

function referenceRelationships(workload: RenderGraphWorkload): readonly Relationship[] {
  const relationships: Relationship[] = [];
  for (let first = 0; first < workload.passes.length; first += 1) {
    for (let second = first + 1; second < workload.passes.length; second += 1) {
      const firstPass = workload.passes[first];
      const secondPass = workload.passes[second];
      if (firstPass === undefined || secondPass === undefined) continue;
      if (
        firstPass.accesses.some((left) =>
          secondPass.accesses.some(
            (right) =>
              left.resourceIndex === right.resourceIndex &&
              (left.mode === 'write' || right.mode === 'write')
          )
        )
      )
        relationships.push(
          Object.freeze([firstPass.registrationIndex, secondPass.registrationIndex])
        );
    }
  }
  return Object.freeze(relationships);
}

function adjacencyFor(
  relationships: readonly Relationship[]
): ReadonlyMap<number, readonly number[]> {
  const adjacency = new Map<number, number[]>();
  for (const [source, target] of relationships) {
    const targets = adjacency.get(source) ?? [];
    targets.push(target);
    adjacency.set(source, targets);
  }
  return adjacency;
}

function equivalentReachability(
  passCount: number,
  reference: readonly Relationship[],
  subject: readonly Relationship[]
): boolean {
  return (
    relationshipChecksum(reachability(passCount, reference)) ===
    relationshipChecksum(reachability(passCount, subject))
  );
}

function reachability(
  passCount: number,
  relationships: readonly Relationship[]
): readonly Relationship[] {
  const adjacency = adjacencyFor(relationships);
  const result: Relationship[] = [];
  for (let from = 0; from < passCount; from += 1) {
    const pending = [...(adjacency.get(from) ?? [])];
    const visited = new Set<number>();
    while (pending.length > 0) {
      const current = pending.pop() as number;
      if (visited.has(current)) continue;
      visited.add(current);
      pending.push(...(adjacency.get(current) ?? []));
    }
    for (const to of [...visited].sort((first, second) => first - second)) {
      if (to > from) result.push(Object.freeze([from, to]));
    }
  }
  return Object.freeze(result);
}

function relationshipChecksum(relationships: readonly Relationship[]): string {
  return textChecksum(relationships.map(([from, to]) => `${from}>${to};`).join(''));
}

function integerListChecksum(values: readonly number[]): string {
  return textChecksum(values.map((value) => `${value};`).join(''));
}

function textChecksum(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
