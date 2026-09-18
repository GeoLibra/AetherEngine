import type { RHIBuffer, RHITexture } from '../../../../rhi/contracts';
import type { CpuLightListResult } from '../../../lighting/types';

/**
 * GPU compute-based light list frame contribution.
 */
export interface BaselineGpuLightListFrame {
  readonly kind: 'gpu';
  readonly result: CpuLightListResult;
  readonly buffer: RHIBuffer;
}

/**
 * WebGL raster-based light list frame contribution.
 */
export interface BaselineWebGlLightListFrame {
  readonly kind: 'webgl';
  readonly result: CpuLightListResult;
  readonly texture: RHITexture;
}

/**
 * CPU bounded fallback light list frame contribution.
 * Uploaded to WebGPU uniform buffer or WebGL RGBA32Uint texture depending on backend.
 */
export interface BaselineCpuLightListFrame {
  readonly kind: 'cpu';
  readonly result: CpuLightListResult;
  readonly buffer?: RHIBuffer;
  readonly texture?: RHITexture;
}

/**
 * Normalized light list execution frame resource, ready for forward render pass consumption.
 */
export type BaselineLightListFrame =
  | BaselineGpuLightListFrame
  | BaselineWebGlLightListFrame
  | BaselineCpuLightListFrame;
