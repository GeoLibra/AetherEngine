import type { RenderEntityId } from './render-world';
import { preparedKey } from './prepared-assets';
import type {
  MaterialPipelineCompatibilityResult,
  RenderPhaseConstructionContext,
  RenderPhaseConstructionResult,
  RenderPhaseConstructionSkip,
  RenderPhaseUpstreamSkip,
  ResolvedMaterialPipelineCandidate
} from './types';

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
  readonly bindingKey?: string;
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
    if (phase !== 'transparent' && key !== undefined && last?.compatibilityKey === key)
      (last.items as PhaseItem[]).push(item);
    else
      batches.push({
        compatibilityKey: key ?? `unbound:${item.entity}:${item.insertionOrder}`,
        items: [item]
      });
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

/**
 * Constructs one immutable view phase from already resolved compatibility candidates.
 * Prepared leases are borrowed; this function never disposes or retains them.
 *
 * @throws When the public queue context has an empty view ID or invalid order origin.
 */
export function constructRenderPhase(
  context: RenderPhaseConstructionContext,
  compatibility: MaterialPipelineCompatibilityResult,
  upstreamSkips: readonly RenderPhaseUpstreamSkip[] = []
): RenderPhaseConstructionResult {
  validateConstructionContext(context);
  const items: PhaseItem[] = [];
  const skipped: (RenderPhaseUpstreamSkip | RenderPhaseConstructionSkip)[] = [
    ...upstreamSkips,
    ...compatibility.skipped
  ];
  compatibility.resolved.forEach((resolved, index) => {
    const skip = validateResolvedCandidate(resolved, context.phase);
    if (skip !== undefined) {
      skipped.push(skip);
      return;
    }
    items.push(createPhaseItem(resolved, context, index));
  });
  return Object.freeze({
    snapshot: buildRenderPhase(context.viewId, context.phase, items),
    skipped: Object.freeze(skipped)
  });
}

function snapshotPhaseItem(item: PhaseItem): PhaseItem {
  return Object.freeze({
    entity: item.entity,
    phase: item.phase,
    pipelineKey: item.pipelineKey,
    materialKey: item.materialKey,
    meshKey: item.meshKey,
    ...(item.bindingKey === undefined ? {} : { bindingKey: item.bindingKey }),
    drawKey: item.drawKey,
    distance: item.distance,
    insertionOrder: item.insertionOrder
  });
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

function compatibilityKey(item: PhaseItem): string | undefined {
  if (item.bindingKey === undefined) return undefined;
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

function validateConstructionContext(context: RenderPhaseConstructionContext): void {
  if (typeof context.viewId !== 'string' || !context.viewId.trim())
    throw new Error('Render phase view ID must be non-empty.');
  if (
    context.insertionOrderOrigin !== undefined &&
    (!Number.isSafeInteger(context.insertionOrderOrigin) || context.insertionOrderOrigin < 0)
  )
    throw new Error('Render phase insertion order origin must be a non-negative safe integer.');
}

function validateResolvedCandidate(
  resolved: ResolvedMaterialPipelineCandidate,
  phase: RenderPhaseKind
): RenderPhaseConstructionSkip | undefined {
  const { candidate, renderState } = resolved;
  if (
    candidate.mesh.disposed ||
    candidate.material.disposed ||
    !Number.isFinite(candidate.depthRange[0]) ||
    !Number.isFinite(candidate.depthRange[1])
  )
    return phaseSkip(
      candidate.entity,
      'invalid-borrowed-candidate',
      'Borrowed candidate facts are invalid or released.'
    );
  if (!surfaceSupportsPhase(renderState.surface, phase))
    return phaseSkip(
      candidate.entity,
      'incompatible-phase-surface',
      `Material surface "${renderState.surface}" cannot enter phase "${phase}".`
    );
  return undefined;
}

function surfaceSupportsPhase(
  surface: ResolvedMaterialPipelineCandidate['renderState']['surface'],
  phase: RenderPhaseKind
): boolean {
  if (phase === 'overlay') return true;
  if (surface === 'transparent') return phase === 'transparent';
  if (surface === 'alpha-mask') return phase === 'alpha-test' || phase === 'shadow';
  return phase === 'opaque' || phase === 'shadow';
}

function createPhaseItem(
  resolved: ResolvedMaterialPipelineCandidate,
  context: RenderPhaseConstructionContext,
  index: number
): PhaseItem {
  const { candidate } = resolved;
  const meshKey = `${preparedKey(candidate.mesh.prepared.key)}|submesh:${candidate.submesh}`;
  const materialKey = `${preparedKey(candidate.material.prepared.key)}|variant:${encodePart(candidate.material.prepared.value.selectedVariant)}`;
  return Object.freeze({
    entity: candidate.entity,
    phase: context.phase,
    pipelineKey: resolved.pipelineKey.hash,
    materialKey,
    meshKey,
    drawKey: `${encodePart(meshKey)}${encodePart(materialKey)}`,
    distance: Math.abs((candidate.depthRange[0] + candidate.depthRange[1]) / 2),
    insertionOrder: (context.insertionOrderOrigin ?? 0) + index
  });
}

function encodePart(value: string): string {
  return `${value.length}:${value}`;
}

function phaseSkip(
  entity: RenderEntityId,
  code: RenderPhaseConstructionSkip['code'],
  message: string
): RenderPhaseConstructionSkip {
  return Object.freeze({ entity, reason: 'incompatible-render-phase', code, message });
}
