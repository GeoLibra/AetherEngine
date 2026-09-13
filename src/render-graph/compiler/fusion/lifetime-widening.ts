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

    const groupStart = group.retainedPassIndices[0]!;
    const groupEnd = group.retainedPassIndices[group.retainedPassIndices.length - 1]!;
    const groupFirstPassId = group.passIds[0]!;
    const groupLastPassId = group.passIds[group.passIds.length - 1]!;

    for (const passIndex of group.retainedPassIndices) {
      const pass = requiredPass(compiled, passIndex);

      for (const access of pass.accesses) {
        widenLifetime(
          requiredLifetime(lifetimes, access.handle.resourceId),
          groupStart,
          groupEnd,
          groupFirstPassId,
          groupLastPassId
        );
      }

      for (const terminal of pass.terminals) {
        widenLifetime(
          requiredLifetime(lifetimes, terminal.handle.resourceId),
          groupStart,
          groupEnd,
          groupFirstPassId,
          groupLastPassId
        );
      }
    }
  }
}

function widenLifetime(
  lifetime: MutableResourceLifetime,
  groupStart: number,
  groupEnd: number,
  groupFirstPassId: number,
  groupLastPassId: number
): void {
  if (groupStart < lifetime.firstUse) {
    lifetime.firstUse = groupStart;
    lifetime.firstPassId = groupFirstPassId;
  }
  if (groupEnd > lifetime.lastUse) {
    lifetime.lastUse = groupEnd;
    lifetime.lastPassId = groupLastPassId;
  }
}

function requiredPass(compiled: CompiledRenderGraph, passIndex: number) {
  const pass = compiled.retainedPasses[passIndex];
  if (pass === undefined) {
    throw new Error(`Render graph fusion references unknown retained pass index ${passIndex}.`);
  }
  return pass;
}

function requiredLifetime(
  lifetimes: Map<number, MutableResourceLifetime>,
  resourceId: number
): MutableResourceLifetime {
  const lifetime = lifetimes.get(resourceId);
  if (lifetime === undefined) {
    throw new Error(
      `Render graph fusion references unknown resource lifetime for resource ${resourceId}.`
    );
  }
  return lifetime;
}
