import type { Vec3 } from '../../math';
import type { RenderEntityId } from '../render-world';
import type { WorldBounds } from '../visibility';

export type LinearRgb = Vec3;

interface LightCommon {
  readonly entity: RenderEntityId;
  readonly payloadVersion: number;
  readonly colorLinear: LinearRgb;
  readonly enabled: boolean;
  readonly layerMask: number;
  readonly castsShadow: boolean;
}

export type PreparedLight =
  | (LightCommon & {
      readonly kind: 'directional';
      readonly direction: Vec3;
      readonly illuminanceLux: number;
    })
  | (LightCommon & {
      readonly kind: 'point';
      readonly position: Vec3;
      readonly luminousIntensityCandela: number;
      readonly range: number;
    })
  | (LightCommon & {
      readonly kind: 'spot';
      readonly position: Vec3;
      readonly direction: Vec3;
      readonly luminousIntensityCandela: number;
      readonly range: number;
      readonly innerRadians: number;
      readonly outerRadians: number;
    });

export interface LightReceiver {
  readonly renderEntity: RenderEntityId;
  readonly layerMask: number;
  readonly enabled?: boolean;
  readonly bounds: WorldBounds;
}

export interface CpuLightListCapacity {
  readonly maxDirectionalLights: number;
  readonly maxLightsPerReceiver: number;
  readonly maxLightIndices: number;
}

export interface CpuLightListHeader {
  readonly receiver: RenderEntityId;
  readonly offset: number;
  readonly count: number;
  readonly overflowed: boolean;
}

export interface CpuLightListCounters {
  readonly inputLights: number;
  readonly inputReceivers: number;
  readonly disabledLights: number;
  readonly layerRejectedLights: number;
  readonly disabledReceivers: number;
  readonly layerRejectedReceivers: number;
  readonly candidatePairs: number;
  readonly intersectionTests: number;
  readonly directionalCount: number;
  readonly directionalTruncated: number;
  readonly emittedIndices: number;
  readonly overflowedReceivers: number;
  readonly truncatedIndices: number;
}

export interface CpuLightListResult {
  readonly source: 'cpu-list';
  readonly fallback: 'none' | 'deterministic-truncate';
  readonly orderedLights: readonly PreparedLight[];
  readonly globalDirectionalLightIndices: readonly number[];
  readonly headers: readonly CpuLightListHeader[];
  readonly lightIndices: readonly number[];
  readonly capacity: CpuLightListCapacity;
  readonly overflowed: boolean;
  readonly counters: CpuLightListCounters;
}

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
