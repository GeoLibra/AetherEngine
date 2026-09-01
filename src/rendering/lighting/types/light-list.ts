import type { RenderEntityId } from '../../world';
import type { WorldBounds } from '../../visibility/types';
import type { PreparedLight } from './light';

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
