/**
 * Reason codes for compiler-driven raster pass fusion boundaries.
 *
 * Categorized by verification nature:
 *
 * ### Category A: Stateless / Immediate Criteria (Pairwise or Local Pass Inspection)
 * Fast, stateless checks between the candidate pass and the active group signature or pass kinds:
 * - `OptimizationDisabled`: Pass fusion is explicitly disabled by options.
 * - `NonRasterBoundary`: Pass is a non-raster pass (compute/copy), which cannot share a raster encoder.
 * - `AttachmentIdentityMismatch`: Color or depth attachment resource identities do not match.
 * - `AttachmentViewMismatch`: Texture mip level, array layer, or aspect range differs.
 * - `AttachmentLayoutMismatch`: Texture sample counts, dimensions, or pixel formats differ.
 * - `IntermediateClear`: Intermediate pass requests a clear loadOp, which would erase prior draws.
 * - `ResolveBoundary`: Group members contain MSAA resolves which must conclude at pass boundaries.
 * - `PipelineAttachmentMismatch`: Static pipeline attachment layout incompatible with active pass.
 * - `SynchronizationBoundary`: Explicit sync edge or barrier separating the passes.
 * - `InstrumentationBoundary`: Debug marker or profiling boundary prohibiting fusion.
 * - `GroupPassLimit`: Enforced maximum limit of logical passes permitted in a single group.
 *
 * ### Category B: Cumulative State & Budget Criteria (Multi-Pass History Inspection)
 * Stateful checks requiring accumulated state machine verification across all earlier group members:
 * - `UsageScopeConflict`: Intra-pass resource role hazard (e.g. attachment vs sampled/storage-read, or buffer RAW/WAR).
 * - `DepthIntroductionUnproven`: Late depth introduction fails safe proof (earlier member accessed depth resource or lacks clear).
 * - `ResidencyBudget`: Physical lifetime widening causes transient memory footprint to exceed residency budget.
 * - `ResidencyEstimateUnavailable`: Required memory footprint estimation metrics unavailable for transient textures.
 */
export const SplitReasonCode = Object.freeze({
  // Category A: Stateless / Immediate Pass & Signature Checks
  OptimizationDisabled: 'optimization-disabled',
  NonRasterBoundary: 'non-raster-boundary',
  AttachmentIdentityMismatch: 'attachment-identity-mismatch',
  AttachmentViewMismatch: 'attachment-view-mismatch',
  AttachmentLayoutMismatch: 'attachment-layout-mismatch',
  IntermediateClear: 'intermediate-clear',
  ResolveBoundary: 'resolve-boundary',
  PipelineAttachmentMismatch: 'pipeline-attachment-mismatch',
  SynchronizationBoundary: 'synchronization-boundary',
  InstrumentationBoundary: 'instrumentation-boundary',
  GroupPassLimit: 'group-pass-limit',

  // Category B: Cumulative State & Budget Checks
  UsageScopeConflict: 'usage-scope-conflict',
  DepthIntroductionUnproven: 'depth-introduction-unproven',
  ResidencyBudget: 'residency-budget',
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
