/**
 * @file Physical render pass merging evaluator and structural metrics for Skybox Background and Opaque passes.
 * Conforms to engine/design/v2/04-rendering/10-skybox-background.md section 8.1.
 */

export interface PassMergeEvaluationOptions {
  readonly backgroundEnabled: boolean;
  readonly backgroundRepresentation: 'panorama' | 'radiance-level-zero' | 'solid' | 'none';
  readonly colorFormat: string;
  readonly depthFormat?: string | undefined;
  readonly width: number;
  readonly height: number;
  readonly sampleCount?: number | undefined;
  /**
   * Whether RHI layout constraints, resource dependencies, or explicit barriers
   * prevent merging into a single physical RenderPass. Default: false.
   *
   * @example
   * // NullDevice/WebGL2 encoders eagerly validate bound groups on setPipeline(),
   * // requiring separate physical passes when pipeline layouts differ between passes.
   * hasInterveningDependency: true
   */
  readonly hasInterveningDependency?: boolean | undefined;
  /**
   * Explicitly disable pass merging for benchmarking, performance comparisons,
   * or debugging. Overrides compatibility analysis. Default: false.
   */
  readonly forceSeparate?: boolean | undefined;
}

export interface PassMergeDecision {
  readonly canMerge: boolean;
  readonly reason: string;
  readonly physicalPassCount: number;
  readonly colorAttachmentOperations: number;
  readonly depthAttachmentOperations: number;
  readonly totalAttachmentOperations: number;
}

/**
 * Evaluates whether adjacent background and opaque render stages can be lowered to
 * a single physical render pass encoder.
 */
export function evaluatePassMerging(options: PassMergeEvaluationOptions): PassMergeDecision {
  if (!options.backgroundEnabled || options.backgroundRepresentation === 'none') {
    return Object.freeze({
      canMerge: false,
      reason: 'background-none',
      physicalPassCount: 1, // only opaque runs
      colorAttachmentOperations: 2,
      depthAttachmentOperations: 2,
      totalAttachmentOperations: 4
    });
  }

  if (options.forceSeparate === true) {
    return Object.freeze({
      canMerge: false,
      reason: 'forced-separate',
      physicalPassCount: 2,
      colorAttachmentOperations: 4, // Pass 1: clear+store; Pass 2: load+store
      depthAttachmentOperations: 2, // Pass 2: clear+store
      totalAttachmentOperations: 6
    });
  }

  if (options.hasInterveningDependency === true) {
    return Object.freeze({
      canMerge: false,
      reason: 'intervening-resource-dependency',
      physicalPassCount: 2,
      colorAttachmentOperations: 4,
      depthAttachmentOperations: 2,
      totalAttachmentOperations: 6
    });
  }

  if (options.width <= 0 || options.height <= 0) {
    return Object.freeze({
      canMerge: false,
      reason: 'zero-render-area',
      physicalPassCount: 0,
      colorAttachmentOperations: 0,
      depthAttachmentOperations: 0,
      totalAttachmentOperations: 0
    });
  }

  // Merged pass is compatible!
  return Object.freeze({
    canMerge: true,
    reason: 'adjacent-compatible-attachments',
    physicalPassCount: 1,
    colorAttachmentOperations: 2, // 1 clear at begin, 1 store at end
    depthAttachmentOperations: 2, // 1 clear at begin, 1 store at end
    totalAttachmentOperations: 4
  });
}
