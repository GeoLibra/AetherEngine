import type { BoundarySplitRecord, FusionCounters, RasterGroupPlan } from '../../types';

/** Creates an empty initialized fusion counters object. */
export function createFusionCounters(retainedLogicalRasterPasses: number): FusionCounters {
  return {
    retainedLogicalRasterPasses,
    physicalRasterGroups: 0,
    fusedBoundariesCount: 0,
    examinedCandidates: 0,
    usageComparisons: 0,
    stateRestorationCommands: 0,
    physicalLifetimeExpansionBytes: 0,
    peakTransientBytes: 0
  };
}

/** Formats a human-readable diagnostic summary of pass fusion decisions. */
export function formatFusionSummary(
  groups: readonly RasterGroupPlan[],
  splitRecords: readonly BoundarySplitRecord[],
  counters: FusionCounters
): string {
  const parts: string[] = [
    `Logical raster passes: ${counters.retainedLogicalRasterPasses}`,
    `Physical groups: ${counters.physicalRasterGroups}`,
    `Fused boundaries: ${counters.fusedBoundariesCount}`,
    `Splits recorded: ${splitRecords.length}`
  ];
  if (splitRecords.length > 0) {
    const reasons = splitRecords.map(
      (r) => `${r.predecessorPassId}->${r.candidatePassId}: ${r.reason}`
    );
    parts.push(`Split reasons: [${reasons.join(', ')}]`);
  }
  return `Pass Fusion Summary (${parts.join(' | ')})`;
}
