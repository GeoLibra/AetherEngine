import {
  RenderGraphBuilder,
  RenderSystemRegistry,
  compileRenderSystems,
  renderSystemToken
} from '../../src/render-graph/builder';
import {
  compileRenderGraph,
  HistoryRegistry,
  type HistoryIdentity
} from '../../src/render-graph/compiler';
import {
  RenderGraphExecutor,
  createRenderGraphExecutionPlan,
  type RenderGraphHistoryBinding
} from '../../src/render-graph/executor';
import { NullDevice } from '../../src/rhi/null/device';
import type { BufferHandle } from '../../src/render-graph/types';

export interface RenderGraphIntegrityObservation {
  readonly semantic: readonly Readonly<Record<string, unknown>>[];
  readonly counters: Readonly<Record<string, number>>;
  readonly checksum: string;
}

export function runHistoryDebugSubject(scale: number): RenderGraphIntegrityObservation {
  assertScale(scale, 'history');
  const device = new NullDevice({ submissionMode: 'manual' });
  const registry = new HistoryRegistry(device);
  const graph = new RenderGraphBuilder();
  const bindings = new Map<BufferHandle, RenderGraphHistoryBinding>();
  const identities = Array.from({ length: scale }, (_, index) => historyIdentity(device, index));
  const initial = identities.map((identity) => registry.acquire(identity));
  registry.invalidateFeaturePolicy({
    domain: 'history',
    previousHash: 'old-policy',
    nextHash: 'next-policy'
  });
  const acquiredHistories = identities.map((identity) => registry.acquire(identity));
  const policyHistoriesInvalidated = acquiredHistories.filter(
    (acquired, index) => acquired.writable.handle !== initial[index]?.writable.handle
  ).length;
  for (let index = 0; index < scale; index++) {
    const identity = identities[index];
    const acquired = acquiredHistories[index];
    if (identity === undefined || acquired === undefined)
      throw new Error('History integrity fixture is incomplete.');
    const history = graph.createBuffer(
      { label: `history-${index}`, size: 64, usage: ['copy-dst'] },
      {
        origin: { kind: 'history', key: identity.key, slots: identity.slots },
        historyValid: acquired.readable !== undefined
      }
    );
    bindings.set(history, { ...acquired, registry, identity });
    graph.addPass({
      id: `history-${index}`,
      setup(pass) {
        pass.writeBuffer(history, 'copy-dst');
        pass.sideEffect(`history-${index}`);
        return undefined;
      },
      run() {}
    });
  }
  const snapshot = graph.build();
  const execution = new RenderGraphExecutor().execute(
    createRenderGraphExecutionPlan(snapshot, compileRenderGraph(snapshot)),
    { device, histories: bindings }
  );
  const histories = execution.debug.resources.filter((resource) => resource.history !== undefined);
  const semantic = histories.map((resource) =>
    Object.freeze({
      resourceId: resource.resourceId,
      writableSlot: resource.history!.writableSlot,
      versionSlots: resource.history!.versionSlots.map(({ version, slot }) =>
        Object.freeze({ version, slot: slot ?? -1 })
      )
    })
  );
  const counters = Object.freeze({
    historyResources: histories.length,
    versionSlots: histories.reduce(
      (sum, resource) => sum + (resource.history?.versionSlots.length ?? 0),
      0
    ),
    boundVersionSlots: histories.reduce(
      (sum, resource) =>
        sum + (resource.history?.versionSlots.filter(({ slot }) => slot !== undefined).length ?? 0),
      0
    ),
    pendingSubmissionReferences: histories.reduce(
      (sum, resource) =>
        sum +
        (resource.history?.slots.reduce(
          (slotSum, slot) => slotSum + slot.pendingSubmissionIds.length,
          0
        ) ?? 0),
      0
    ),
    policyHistoriesInvalidated,
    policyHistoriesPreserved: scale - policyHistoriesInvalidated,
    scheduledSteps: execution.executionCounters.scheduledSteps
  });
  device.queue.completeNextForTesting();
  return observation(semantic, counters);
}

/** Closed-form oracle for N independent two-slot histories written by one submission. */
export function runHistoryDebugReference(scale: number): RenderGraphIntegrityObservation {
  assertScale(scale, 'history');
  const semantic = Array.from({ length: scale }, (_, resourceId) =>
    Object.freeze({
      resourceId,
      writableSlot: 0,
      versionSlots: Object.freeze([
        Object.freeze({ version: 0, slot: -1 }),
        Object.freeze({ version: 1, slot: 0 })
      ])
    })
  );
  return observation(
    semantic,
    Object.freeze({
      historyResources: scale,
      versionSlots: scale * 2,
      boundVersionSlots: scale,
      pendingSubmissionReferences: scale,
      policyHistoriesInvalidated: Math.ceil(scale / 2),
      policyHistoriesPreserved: Math.floor(scale / 2),
      scheduledSteps: scale + 2
    })
  );
}

export function runRenderSystemSubject(scale: number): RenderGraphIntegrityObservation {
  assertScale(scale, 'render-system');
  const registry = new RenderSystemRegistry();
  for (let index = 0; index < scale; index++) {
    registry.add({
      id: `system-${index}`,
      scope: 'global',
      ...(index === 0 ? {} : { after: [renderSystemToken(`system-${index - 1}`)] }),
      setup(pass) {
        pass.sideEffect(`system-${index}`);
        return undefined;
      },
      run() {}
    });
  }
  const compiled = compileRenderSystems(registry, { views: [] });
  const idByPass = new Map(compiled.debug.passes.map((pass) => [pass.passId, pass.id]));
  const order = compiled.debug.order.map((passId) => idByPass.get(passId) ?? '<missing>');
  return observation(
    order.map((id, index) => Object.freeze({ index, id })),
    Object.freeze({
      instances: compiled.instances.length,
      semanticEdges: compiled.debug.edges.filter(({ kind }) => kind === 'semantic').length,
      scheduleSteps: compiled.plan.schedule.length,
      internalNodes: compiled.internalNodes.length
    })
  );
}

/** Closed-form oracle for the semantic predecessor chain authored above. */
export function runRenderSystemReference(scale: number): RenderGraphIntegrityObservation {
  assertScale(scale, 'render-system');
  return observation(
    Array.from({ length: scale }, (_, index) =>
      Object.freeze({ index, id: `system-${index}@global` })
    ),
    Object.freeze({
      instances: scale,
      semanticEdges: scale - 1,
      scheduleSteps: scale + 2,
      internalNodes: 2
    })
  );
}

function historyIdentity(device: NullDevice, index: number): HistoryIdentity {
  return {
    deviceGeneration: device.generation,
    viewId: 'benchmark',
    key: `history-${index}`,
    descriptor: Object.freeze({
      kind: 'buffer',
      descriptor: Object.freeze({ size: 64, usage: 8 })
    }),
    slots: 2,
    abi: 'benchmark-history-v1',
    policy: index % 2 === 0 ? 'old-policy' : 'other-policy'
  };
}

function observation(
  semantic: readonly Readonly<Record<string, unknown>>[],
  counters: Readonly<Record<string, number>>
): RenderGraphIntegrityObservation {
  const frozenSemantic = Object.freeze([...semantic]);
  return Object.freeze({
    semantic: frozenSemantic,
    counters,
    checksum: checksum(JSON.stringify({ semantic: frozenSemantic, counters }))
  });
}

function checksum(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function assertScale(scale: number, lane: string): void {
  if (!Number.isSafeInteger(scale) || scale <= 0) {
    throw new Error(`${lane} integrity benchmark scale must be a positive integer.`);
  }
}
