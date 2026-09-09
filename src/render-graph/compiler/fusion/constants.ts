/**
 * Constants and reason codes for compiler-driven raster pass fusion.
 */

export const SplitReasonCode = Object.freeze({
  OptimizationDisabled: 'optimization-disabled',
  NonRasterBoundary: 'non-raster-boundary',
  LegacyOpaque: 'legacy-opaque',
  AttachmentIdentityMismatch: 'attachment-identity-mismatch',
  AttachmentViewMismatch: 'attachment-view-mismatch',
  AttachmentLayoutMismatch: 'attachment-layout-mismatch',
  IntermediateClear: 'intermediate-clear',
  ResolveBoundary: 'resolve-boundary',
  UsageScopeConflict: 'usage-scope-conflict',
  PipelineAttachmentMismatch: 'pipeline-attachment-mismatch',
  DepthIntroductionUnproven: 'depth-introduction-unproven',
  SynchronizationBoundary: 'synchronization-boundary',
  InstrumentationBoundary: 'instrumentation-boundary',
  ResidencyBudget: 'residency-budget',
  GroupPassLimit: 'group-pass-limit',
  ResidencyEstimateUnavailable: 'residency-estimate-unavailable'
} as const);

export type SplitReasonCode = (typeof SplitReasonCode)[keyof typeof SplitReasonCode];

/** Default pass fusion options with unlimited budgets and fusion enabled. */
export const DEFAULT_FUSION_OPTIONS = Object.freeze({
  enablePassFusion: true,
  maxResidencyExpansionBytes: 'unlimited' as const,
  maxGroupPassCount: 'unlimited' as const
});
