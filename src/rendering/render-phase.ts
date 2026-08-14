import type { RenderEntityId } from './render-world';

export type RenderPhaseKind = 'shadow' | 'opaque' | 'alpha-test' | 'transparent' | 'overlay';

/**
 * A single draw candidate recorded for a specific camera view.
 */
export interface PhaseItem {
  readonly entity: RenderEntityId;
  readonly phase: RenderPhaseKind;
  readonly pipelineKey: string;
  readonly materialKey: string;
  readonly meshKey: string;
  readonly bindingKey: string;
  readonly drawKey: string;
  readonly distance: number; // View-space depth distance from the camera
  readonly insertionOrder: number;
}

/**
 * A group of compatible PhaseItems that can be merged into a single multi-draw or instanced call.
 */
export interface PhaseBatch {
  readonly compatibilityKey: string;
  readonly items: readonly PhaseItem[];
}

/**
 * A snapshot of all visible items and batches associated with a specific camera view and phase.
 */
export interface RenderPhaseSnapshot {
  readonly viewId: string;
  readonly phase: RenderPhaseKind;
  readonly items: readonly PhaseItem[];
  readonly batches: readonly PhaseBatch[];
}

/**
 * Builds, sorts, and batches draw items for a specific view and render phase.
 *
 * Invariants:
 * - Transparent items are sorted strictly far-to-near (painter's algorithm) and batching
 *   must NEVER cross transparency ordering boundaries.
 * - Opaque/Shadow items are sorted by pipeline key -> material key -> mesh key to minimize
 *   GPU state changes (cache coherence) and can be grouped aggressively.
 */
export function buildRenderPhase(
  viewId: string,
  phase: RenderPhaseKind,
  input: readonly PhaseItem[]
): RenderPhaseSnapshot {
  const items = input
    .filter((item) => item.phase === phase)
    .map(snapshotPhaseItem)
    .sort(phaseComparator(phase));
  const batches: PhaseBatch[] = [];
  for (const item of items) {
    const key = compatibilityKey(item);
    const last = batches.at(-1);
    // Transparent order is semantic and must never be crossed by opportunistic grouping.
    if (phase !== 'transparent' && last?.compatibilityKey === key)
      (last.items as PhaseItem[]).push(item);
    else batches.push({ compatibilityKey: key, items: [item] });
  }
  return Object.freeze({
    viewId,
    phase,
    items: Object.freeze(items),
    batches: Object.freeze(
      batches.map((batch) => Object.freeze({ ...batch, items: Object.freeze(batch.items) }))
    )
  });
}

function snapshotPhaseItem(item: PhaseItem): PhaseItem {
  return Object.freeze({ ...item });
}

/**
 * Formulates a unique pipeline identification key incorporating shader modules,
 * material parameters, vertex buffer descriptors, and RHI targets configurations.
 */
export function resolvePipelineKey(input: {
  shader: string;
  material: string;
  vertexLayout: string;
  attachments: readonly string[];
  sampleCount: number;
  featurePolicy: string;
}): string {
  return [
    input.shader,
    input.material,
    input.vertexLayout,
    input.attachments.join(','),
    input.sampleCount,
    input.featurePolicy
  ].join('|');
}

function compatibilityKey(item: PhaseItem): string {
  return [item.pipelineKey, item.materialKey, item.meshKey, item.bindingKey, item.drawKey].join(
    '|'
  );
}

/**
 * Resolves sorting logic depending on the phase kind:
 * - Opaque/Shadow: pipeline coherence first, then material and mesh.
 * - Transparent: back-to-front view distance.
 * - Overlay: strict insertion index order.
 */
function phaseComparator(phase: RenderPhaseKind): (left: PhaseItem, right: PhaseItem) => number {
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
