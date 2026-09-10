import type { CompiledRenderGraph, RasterGroupPlan } from '../../types';

export interface MutableResourceLifetime {
  readonly resourceId: number;
  firstUse: number;
  lastUse: number;
  firstPassId: number;
  lastPassId: number;
}

/**
 * Widens physical resource intervals to cover entire fused group boundaries [group.start, group.end].
 * Prevents intermediate aliasing violations or premature destruction of transient resources inside fused passes.
 */
export function widenLifetimesForRasterGroups(
  lifetimes: Map<number, MutableResourceLifetime>,
  compiled: CompiledRenderGraph,
  rasterGroups: readonly RasterGroupPlan[]
): void {
  for (const group of rasterGroups) {
    if (group.retainedPassIndices.length <= 1) continue;
    const groupStart = group.retainedPassIndices[0];
    const groupEnd = group.retainedPassIndices[group.retainedPassIndices.length - 1];
    const groupFirstPassId = group.passIds[0];
    const groupLastPassId = group.passIds[group.passIds.length - 1];

    if (
      groupStart === undefined ||
      groupEnd === undefined ||
      groupFirstPassId === undefined ||
      groupLastPassId === undefined
    ) {
      continue;
    }

    for (const passIndex of group.retainedPassIndices) {
      const pass = compiled.retainedPasses[passIndex];
      if (pass === undefined) continue;
      for (const access of pass.accesses) {
        const lifetime = lifetimes.get(access.handle.resourceId);
        if (lifetime !== undefined) {
          if (groupStart < lifetime.firstUse) {
            lifetime.firstUse = groupStart;
            lifetime.firstPassId = groupFirstPassId;
          }
          if (groupEnd > lifetime.lastUse) {
            lifetime.lastUse = groupEnd;
            lifetime.lastPassId = groupLastPassId;
          }
        }
      }
      for (const terminal of pass.terminals) {
        const lifetime = lifetimes.get(terminal.handle.resourceId);
        if (lifetime !== undefined) {
          if (groupStart < lifetime.firstUse) {
            lifetime.firstUse = groupStart;
            lifetime.firstPassId = groupFirstPassId;
          }
          if (groupEnd > lifetime.lastUse) {
            lifetime.lastUse = groupEnd;
            lifetime.lastPassId = groupLastPassId;
          }
        }
      }
    }
  }
}
