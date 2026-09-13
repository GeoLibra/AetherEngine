export {
  compileRenderGraph,
  isCompiledRenderGraph,
  isCompiledRenderGraphForSnapshot,
  RenderGraphCycleError,
  RenderGraphSemanticHazardError
} from './schedule';

export {
  analyzeResourceLifetimes,
  planResourceAliases,
  derivePortableTransitions
} from './resources';

export { deriveRenderGraphHazards } from './hazards';

export {
  SplitReasonCode,
  partitionRasterGroups,
  validateFusionOptions,
  widenLifetimesForRasterGroups,
  type ActiveRasterGroup,
  type FusionEvaluation,
  type MutableFusionCounters
} from './fusion';
