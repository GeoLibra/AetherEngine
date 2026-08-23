import {
  buildRenderPhase,
  constructRenderPhase,
  type PhaseItem,
  type MaterialPipelineCompatibilityResult,
  type RenderEntityId,
  type RenderPhaseKind,
  type ResolvedMaterialPipelineCandidate
} from '../../src/rendering';

export interface RenderPhaseWorkload {
  readonly phase: RenderPhaseKind;
  readonly items: readonly PhaseItem[];
}

export interface CanonicalRenderPhase {
  readonly entities: readonly RenderEntityId[];
  readonly batchSizes: readonly number[];
}

export interface PhaseConstructionWorkload {
  readonly compatibility: MaterialPipelineCompatibilityResult;
  readonly expectedItems: number;
  readonly expectedSkips: number;
  readonly ownership: { disposals: number; retentions: number };
}

export interface PhaseConstructionSummary {
  readonly items: number;
  readonly skips: number;
  readonly checksum: number;
  readonly ownershipTransfers: number;
}

export function createPhaseConstructionWorkload(count: number): PhaseConstructionWorkload {
  const ownership = { disposals: 0, retentions: 0 };
  const resolved = Array.from({ length: count }, (_, index) =>
    constructionCandidate(index, index % 10 === 0 ? 'transparent' : 'opaque', ownership)
  );
  return Object.freeze({
    compatibility: Object.freeze({ resolved: Object.freeze(resolved), skipped: Object.freeze([]) }),
    expectedItems: count - Math.ceil(count / 10),
    expectedSkips: Math.ceil(count / 10),
    ownership
  });
}

export function runPhaseConstructionSubject(
  workload: PhaseConstructionWorkload
): PhaseConstructionSummary {
  const result = constructRenderPhase(
    { viewId: 'benchmark', phase: 'opaque' },
    workload.compatibility
  );
  return Object.freeze({
    items: result.snapshot.items.length,
    skips: result.skipped.length,
    checksum: result.snapshot.items.reduce(
      (sum, item, index) => sum + item.entity * (index + 1),
      0
    ),
    ownershipTransfers: workload.ownership.disposals + workload.ownership.retentions
  });
}

export function createRenderPhaseWorkload(
  count: number,
  phase: RenderPhaseKind = 'opaque',
  seed = 149
): RenderPhaseWorkload {
  let state = seed >>> 0;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000;
  return Object.freeze({
    phase,
    items: Object.freeze(
      Array.from({ length: count }, (_, index) =>
        Object.freeze({
          entity: (count - index) as RenderEntityId,
          phase: index % 11 === 0 ? ('overlay' as const) : phase,
          pipelineKey: `pipeline-${index % 5}`,
          materialKey: `material-${index % 7}`,
          meshKey: `mesh-${index % 3}`,
          bindingKey: `binding-${index % 4}`,
          drawKey: `draw-${index % 2}`,
          distance: Math.floor(random() * 10_000) / 100,
          insertionOrder: index
        })
      )
    )
  });
}

export function runRenderPhaseSubject(workload: RenderPhaseWorkload): CanonicalRenderPhase {
  const snapshot = buildRenderPhase('benchmark', workload.phase, workload.items);
  return Object.freeze({
    entities: Object.freeze(snapshot.items.map((item) => item.entity)),
    batchSizes: Object.freeze(snapshot.batches.map((batch) => batch.items.length))
  });
}

/** Independent scalar ordering and batching oracle for RenderPhase snapshots. */
export function runRenderPhaseReference(workload: RenderPhaseWorkload): CanonicalRenderPhase {
  const items = workload.items
    .filter((item) => item.phase === workload.phase)
    .sort(comparator(workload.phase));
  const batchSizes: number[] = [];
  let previousKey: string | undefined;
  for (const item of items) {
    const key = [
      item.pipelineKey,
      item.materialKey,
      item.meshKey,
      item.bindingKey,
      item.drawKey
    ].join('|');
    if (workload.phase === 'transparent' || previousKey !== key) batchSizes.push(1);
    else batchSizes[batchSizes.length - 1]!++;
    previousKey = key;
  }
  return Object.freeze({
    entities: Object.freeze(items.map((item) => item.entity)),
    batchSizes: Object.freeze(batchSizes)
  });
}

function comparator(phase: RenderPhaseKind): (left: PhaseItem, right: PhaseItem) => number {
  return (left, right) => {
    if (phase === 'transparent')
      return (
        right.distance - left.distance ||
        left.entity - right.entity ||
        left.insertionOrder - right.insertionOrder
      );
    if (phase === 'overlay')
      return left.insertionOrder - right.insertionOrder || left.entity - right.entity;
    return (
      compareCodeUnits(left.pipelineKey, right.pipelineKey) ||
      compareCodeUnits(left.materialKey, right.materialKey) ||
      compareCodeUnits(left.meshKey, right.meshKey) ||
      compareCodeUnits(left.drawKey, right.drawKey) ||
      left.entity - right.entity ||
      left.insertionOrder - right.insertionOrder
    );
  };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function constructionCandidate(
  index: number,
  surface: 'opaque' | 'transparent',
  ownership: PhaseConstructionWorkload['ownership']
): ResolvedMaterialPipelineCandidate {
  const key = (assetId: string) =>
    Object.freeze({
      assetId,
      payloadVersion: 1,
      deviceGeneration: 1,
      featurePolicyKey: 'benchmark',
      abiVersion: 'v1'
    });
  const lease = (assetId: string, value: unknown) =>
    Object.freeze({
      prepared: Object.freeze({ key: key(assetId), value }),
      disposed: false,
      dispose: () => ownership.disposals++,
      retainUntil: () => ownership.retentions++
    });
  return {
    candidate: {
      entity: (index + 1) as RenderEntityId,
      depthRange: Object.freeze([-index - 2, -index - 1] as const),
      submesh: index % 4,
      mesh: lease(
        `mesh:${index % 32}`,
        {}
      ) as ResolvedMaterialPipelineCandidate['candidate']['mesh'],
      material: lease(`material:${index % 16}`, {
        selectedVariant: `variant:${index % 8}`
      }) as ResolvedMaterialPipelineCandidate['candidate']['material']
    },
    selection: Object.freeze({
      status: 'selected',
      technique: Object.freeze({ name: 'benchmark' }),
      requestedRole: 'benchmark',
      selectedRole: 'benchmark',
      candidatesExamined: 1
    }) as ResolvedMaterialPipelineCandidate['selection'],
    renderState: Object.freeze({
      status: 'resolved',
      phase: surface === 'opaque' ? 'opaque' : 'transparent',
      surface,
      depthTest: true,
      depthWrite: surface === 'opaque',
      colorWrite: true,
      cullMode: 'back',
      blend: undefined
    }),
    pipelineKey: Object.freeze({
      hash: `pipeline:${index % 64}`
    }) as ResolvedMaterialPipelineCandidate['pipelineKey']
  };
}
