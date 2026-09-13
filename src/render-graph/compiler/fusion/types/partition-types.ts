import type { GraphPassDeclaration } from '../../../builder/builder';
import type { SplitReasonCode } from '../constants';
import type { RasterPassSignature } from '../signature';
import type { GroupUsageAccumulator } from '../usage';

export interface ActiveRasterGroup {
  members: GraphPassDeclaration[];
  signature: RasterPassSignature;
  usageAccumulator: GroupUsageAccumulator;
  hasLateDepth: boolean;
}

export interface MutableFusionCounters {
  retainedLogicalRasterPasses: number;
  physicalRasterGroups: number;
  fusedBoundariesCount: number;
  examinedCandidates: number;
  usageComparisons: number;
  stateRestorationCommands: number;
  physicalLifetimeExpansionBytes: number;
  peakTransientBytes: number;
}

export interface FusionEvaluation {
  readonly splitReason: SplitReasonCode | null;
  readonly lateDepthSafe: boolean;
}
