import type { RenderEntityId } from '../../world';

export type ShadowRequestKind = 'directional-cascade' | 'spot' | 'point-face';

export interface ShadowRequest {
  readonly lightEntity: RenderEntityId;
  readonly viewId: string;
  readonly kind: ShadowRequestKind;
  /** Cascade or cube-face identity. Spot requests use zero. */
  readonly subresourceIndex: number;
  /** Requested square tile edge in physical pixels. */
  readonly resolutionClass: number;
  readonly importance: number;
  readonly casterRevision: number;
}

export interface ShadowBudget {
  readonly maxRequests: number;
  readonly maxTexels: number;
}

export type ShadowRejectionReason = 'request-capacity' | 'texel-capacity';

export interface ShadowRequestSelection {
  readonly accepted: readonly ShadowRequest[];
  readonly rejected: readonly Readonly<{
    request: ShadowRequest;
    reason: ShadowRejectionReason;
  }>[];
  readonly usedTexels: number;
}

export interface ShadowAtlasTileHandle {
  readonly key: string;
  readonly generation: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ShadowAtlasMetrics {
  readonly generation: number;
  readonly width: number;
  readonly height: number;
  readonly allocatedTiles: number;
  readonly allocatedTexels: number;
  readonly occupancy: number;
}

export interface ShadowAtlasRelocation {
  readonly key: string;
  readonly previous: ShadowAtlasTileHandle;
  readonly next: ShadowAtlasTileHandle;
}

export interface ShadowAtlasCompactionResult {
  readonly generation: number;
  readonly relocations: readonly ShadowAtlasRelocation[];
}
