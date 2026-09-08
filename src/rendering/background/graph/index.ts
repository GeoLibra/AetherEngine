export {
  createBackgroundRenderSystem,
  type BackgroundRenderSystemInput
} from './background-render-system';

export { contributeBackground, type BackgroundGraphContribution } from './background-contribution';

export {
  evaluatePassMerging,
  type PassMergeDecision,
  type PassMergeEvaluationOptions
} from './pass-merging';
