import type { AssetHandle, GeometryMeshAsset, MaterialAssetPayload } from '../../../assets';
import type { MeshData } from '../../../geometry';
import type { StandardLitMaterial } from '../../../material';
import type { BrowserGraphicsSession } from '../../../platform';
import type { PreparedDrawPacket } from '../../phase';
import type { RenderView } from '../../visibility';

export type BaselineRenderSkipReason =
  | 'surface-suspended'
  | 'prepare-pending'
  | 'missing-resource'
  | 'stale-device-generation'
  | 'stale-surface-generation';

/** Immutable public outcome for the most recent baseline rendering attempt. */
export type BaselineRenderDiagnostics =
  | Readonly<{
      frame: 0;
      viewId: string;
      status: 'idle';
      deviceGeneration: number;
      surfaceGeneration: number;
    }>
  | Readonly<{
      frame: number;
      viewId: string;
      status: 'rendered';
      indexedDrawCalls: number;
      indexCount: number;
      submissionId: number;
      deviceGeneration: number;
      surfaceGeneration: number;
    }>
  | Readonly<{
      frame: number;
      viewId: string;
      status: 'skipped';
      reason: BaselineRenderSkipReason;
      deviceGeneration: number;
      surfaceGeneration: number;
    }>;

/** Preparation-owned immutable snapshot consumed synchronously by the frame boundary. */
export type BaselinePreparedFrame =
  | Readonly<{
      status: 'pending' | 'missing';
      view: RenderView;
      deviceGeneration: number;
      surfaceGeneration: number;
    }>
  | Readonly<{
      status: 'ready';
      view: RenderView;
      packets: readonly PreparedDrawPacket[];
      deviceGeneration: number;
      surfaceGeneration: number;
    }>;

/** Dependencies for the opt-in single-surface baseline renderer. */
export interface BaselineRenderingOptions {
  readonly graphics: BrowserGraphicsSession;
  /** Stable public identity for the single baseline view. Defaults to `main`. */
  readonly viewId?: string;
  /** FeaturePolicy snapshot identity consumed by preparation and Queue. */
  readonly featurePolicyKey?: string;
  /** Optional canonical box-compatible mesh registration prepared outside Queue. */
  readonly mesh?: Readonly<{
    handle: AssetHandle<GeometryMeshAsset>;
    payloadVersion: number;
    data: MeshData;
  }>;
  /** Optional standard-lit material registration prepared outside Queue. */
  readonly material?: Readonly<{
    handle: AssetHandle<MaterialAssetPayload>;
    payloadVersion: number;
    material: StandardLitMaterial;
  }>;
}
