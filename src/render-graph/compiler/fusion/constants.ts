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

/**
 * Texture format size in bytes per pixel.
 * Used for estimating transient resource memory footprint.
 * Null indicates the format is not yet mapped; extend as needed.
 */
export const TEXTURE_FORMAT_BYTES: Record<string, number | null> = Object.freeze({
  // 8-bit formats
  r8unorm: 1,
  r8snorm: 1,
  r8uint: 1,
  r8sint: 1,
  stencil8: 1,
  // 16-bit formats
  rg8unorm: 2,
  rg8snorm: 2,
  rg8uint: 2,
  rg8sint: 2,
  r16uint: 2,
  r16sint: 2,
  r16float: 2,
  depth16unorm: 2,
  // 32-bit formats
  rgba8unorm: 4,
  'rgba8unorm-srgb': 4,
  bgra8unorm: 4,
  'bgra8unorm-srgb': 4,
  rg16uint: 4,
  rg16sint: 4,
  rg16float: 4,
  r32uint: 4,
  r32sint: 4,
  r32float: 4,
  depth32float: 4,
  depth24plus: 4,
  'depth24plus-stencil8': 4,
  // 64-bit formats
  rgba16uint: 8,
  rgba16sint: 8,
  rgba16float: 8,
  rg32uint: 8,
  rg32sint: 8,
  rg32float: 8,
  'depth32float-stencil8': 8,
  // 128-bit formats
  rgba32uint: 16,
  rgba32sint: 16,
  rgba32float: 16
} as const);
