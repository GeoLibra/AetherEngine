import {
  buildRenderPhase,
  type PhaseItem,
  type RenderEntityId,
  type RenderPhaseKind
} from '../../src/rendering';

export interface RenderPhaseWorkload {
  readonly phase: RenderPhaseKind;
  readonly items: readonly PhaseItem[];
}

export interface CanonicalRenderPhase {
  readonly entities: readonly RenderEntityId[];
  readonly batchSizes: readonly number[];
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
      left.pipelineKey.localeCompare(right.pipelineKey) ||
      left.materialKey.localeCompare(right.materialKey) ||
      left.meshKey.localeCompare(right.meshKey) ||
      left.entity - right.entity ||
      left.insertionOrder - right.insertionOrder
    );
  };
}
