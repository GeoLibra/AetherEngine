import { ReadonlyMapSnapshot } from '../world/readonly-collection-snapshot';
import type {
  CompositionPlan,
  CompositionPlanInput,
  CompositionSlot,
  CompositionSlotInput,
  CompositionSurfaceSnapshot
} from './types';
import { CompositionPlanError } from './errors';

/** Validates caller-owned composition intent and publishes a detached canonical plan. */
export function compileCompositionPlan(input: CompositionPlanInput): CompositionPlan {
  if (!input.id.trim() || !input.policyHash.trim())
    throw new Error('Composition identity must be non-empty.');
  if (!Number.isSafeInteger(input.revision) || input.revision < 0)
    throw new Error('Composition revision must be a non-negative integer.');
  const surfaces = snapshotSurfaces(input.surfaces);
  const bySurface = new Map(surfaces.map((surface) => [surface.id, surface]));
  const ids = new Set<string>();
  const slots = input.slots
    .map((slot) => {
      if (!slot.id.trim() || !slot.viewId.trim() || !slot.targetId.trim())
        throw new Error('Composition slot identity must be non-empty.');
      if (ids.has(slot.id))
        throw new CompositionPlanError(
          'duplicate-slot-id',
          `Duplicate composition slot "${slot.id}".`,
          slot.id
        );
      ids.add(slot.id);
      const surface = bySurface.get(slot.targetId);
      if (surface === undefined)
        throw new Error(
          `Composition slot "${slot.id}" references unknown target "${slot.targetId}".`
        );
      validateViewport(slot, surface);
      return Object.freeze({
        ...slot,
        viewportPixels: Object.freeze({ ...slot.viewportPixels }),
        stores: Object.freeze({ ...slot.stores }),
        enabled: slot.enabled ?? true
      });
    })
    .filter((slot) => slot.enabled)
    .sort(compareSlots);
  const slotsBySurface = groupSlotsBySurface(slots);
  validateLineages(slotsBySurface, bySurface);
  const owners = new Map<string, string>();
  for (const surface of surfaces) {
    if (surface.suspended || surface.width === 0 || surface.height === 0) continue;
    const surfaceSlots = slotsBySurface.get(surface.id) ?? [];
    const presenting = surfaceSlots.filter((slot) => slot.present);
    if (presenting.length === 0)
      throw new CompositionPlanError(
        'surface-present-owner-missing',
        `Surface "${surface.id}" has no present owner.`,
        undefined,
        surface.id
      );
    if (presenting.length > 1)
      throw new CompositionPlanError(
        'surface-present-owner-duplicate',
        `Surface "${surface.id}" has multiple present owners.`,
        undefined,
        surface.id
      );
    const owner = presenting[0]!;
    const last = surfaceSlots.at(-1);
    if (owner !== last)
      throw new CompositionPlanError(
        'store-required',
        `Present owner "${owner.id}" is not the final slot for surface "${surface.id}".`,
        owner.id,
        surface.id
      );
    if (!owner.stores.color)
      throw new CompositionPlanError(
        'store-required',
        `Present owner "${owner.id}" must store color content.`,
        owner.id,
        surface.id
      );
    owners.set(surface.id, owner.id);
  }
  const hash = canonicalHash({
    id: input.id,
    policyHash: input.policyHash,
    surfaces,
    slots,
    owners: [...owners].sort()
  });
  return Object.freeze({
    id: input.id,
    revision: input.revision,
    policyHash: input.policyHash,
    surfaces,
    slots: Object.freeze(slots),
    presentOwners: new ReadonlyMapSnapshot(owners),
    hash
  });
}

function snapshotSurfaces(
  values: readonly CompositionSurfaceSnapshot[]
): readonly CompositionSurfaceSnapshot[] {
  const ids = new Set<string>();
  return Object.freeze(
    values
      .map((surface) => {
        if (!surface.id.trim() || ids.has(surface.id))
          throw new Error(`Duplicate or empty composition surface "${surface.id}".`);
        ids.add(surface.id);
        if (
          !Number.isSafeInteger(surface.generation) ||
          surface.generation < 0 ||
          !Number.isSafeInteger(surface.width) ||
          surface.width < 0 ||
          !Number.isSafeInteger(surface.height) ||
          surface.height < 0
        )
          throw new Error(`Composition surface "${surface.id}" has invalid generation or extent.`);
        return Object.freeze({ ...surface });
      })
      .sort((left, right) => left.id.localeCompare(right.id))
  );
}

function compareSlots(left: CompositionSlot, right: CompositionSlot): number {
  return (
    left.targetId.localeCompare(right.targetId) ||
    left.order - right.order ||
    left.id.localeCompare(right.id)
  );
}

function validateViewport(slot: CompositionSlotInput, surface: CompositionSurfaceSnapshot): void {
  const viewport = slot.viewportPixels;
  if (
    ![viewport.x, viewport.y, viewport.width, viewport.height].every(Number.isSafeInteger) ||
    viewport.x < 0 ||
    viewport.y < 0 ||
    viewport.width < 0 ||
    viewport.height < 0 ||
    viewport.x + viewport.width > surface.width ||
    viewport.y + viewport.height > surface.height
  ) {
    throw new CompositionPlanError(
      'viewport-out-of-bounds',
      `Composition slot "${slot.id}" viewport exceeds surface "${surface.id}".`,
      slot.id,
      surface.id
    );
  }
}

function groupSlotsBySurface(
  slots: readonly CompositionSlot[]
): ReadonlyMap<string, readonly CompositionSlot[]> {
  const grouped = new Map<string, CompositionSlot[]>();
  for (const slot of slots) {
    const group = grouped.get(slot.targetId);
    if (group === undefined) grouped.set(slot.targetId, [slot]);
    else group.push(slot);
  }
  return grouped;
}

function validateLineages(
  slotsBySurface: ReadonlyMap<string, readonly CompositionSlot[]>,
  surfaces: ReadonlyMap<string, CompositionSurfaceSnapshot>
): void {
  for (const surface of surfaces.values()) {
    if (surface.suspended || surface.width === 0 || surface.height === 0) continue;
    let initialized = false;
    let depthInitialized = false;
    const targetSlots = slotsBySurface.get(surface.id) ?? [];
    for (let index = 0; index < targetSlots.length; index++) {
      const slot = targetSlots[index]!;
      for (let priorIndex = index - 1; priorIndex >= 0; priorIndex--) {
        const prior = targetSlots[priorIndex]!;
        if (prior.order !== slot.order) break;
        if (overlaps(prior.viewportPixels, slot.viewportPixels)) {
          throw new CompositionPlanError(
            'ambiguous-slot-order',
            `Composition slots "${prior.id}" and "${slot.id}" have ambiguous overlapping order.`,
            slot.id,
            surface.id
          );
        }
      }
      if (slot.colorLoad === 'load' && !initialized)
        throw new CompositionPlanError(
          'load-without-content',
          `Composition slot "${slot.id}" loads uninitialized color.`,
          slot.id,
          surface.id
        );
      if (slot.depthLoad === 'load' && !depthInitialized)
        throw new CompositionPlanError(
          'load-without-content',
          `Composition slot "${slot.id}" loads uninitialized depth.`,
          slot.id,
          surface.id
        );
      initialized = slot.colorLoad !== 'discard' && slot.stores.color;
      // A slot without a depth attachment cannot alter content retained by an earlier slot.
      if (slot.depthLoad !== 'none') {
        depthInitialized = slot.depthLoad !== 'discard' && slot.stores.depth;
      }
    }
  }
}

function overlaps(
  a: CompositionSlot['viewportPixels'],
  b: CompositionSlot['viewportPixels']
): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function canonicalHash(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index++)
    hash = Math.imul(hash ^ text.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}
