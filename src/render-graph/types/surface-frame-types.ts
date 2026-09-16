/**
 * Terminal capability token representing an acquired surface frame for presentation.
 * Scoped strictly to the current frame executor invocation.
 */
export interface SurfaceFrameToken {
  readonly kind: 'surface-frame';
  readonly id: string;
}
