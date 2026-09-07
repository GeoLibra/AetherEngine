import type {
  AssetHandle,
  EnvironmentAsset,
  GeometryMeshAsset,
  MaterialAssetPayload
} from '../../../assets';
import type { MeshData } from '../../../geometry';
import type { StandardLitMaterial } from '../../../material';
import type { BrowserGraphicsSession } from '../../../platform';
import type {
  RHIBindGroupLayout,
  RHIBuffer,
  RHISubmission,
  RHITexture
} from '../../../rhi/contracts';
import type { PreparedBindGroupLayoutToken } from '../../../render-graph';
import type {
  PreparedWebGlLightListRecorder,
  PreparedWebGpuLightListRecorder
} from '../../lighting';
import type { PreparedDrawPacket } from '../../phase';
import type { RenderView } from '../../visibility';
import type { BaselinePostColorPreparation } from '../baseline-post-color';

/** Submission-scoped LightList inputs and environment resources consumed by forward shading. */
export type BaselineLightListFrame =
  | Readonly<{
      source: 'gpu-compute';
      lights: RHIBuffer;
      receivers: RHIBuffer;
      receiverCount: number;
      recorder: PreparedWebGpuLightListRecorder;
      forwardBindGroupLayoutToken: PreparedBindGroupLayoutToken;
      forwardBindGroupLayout: RHIBindGroupLayout;
      environmentBuffer: RHIBuffer;
      irradianceMap: RHITexture;
      prefilteredRadianceMap: RHITexture;
      environmentBrdfLut: RHITexture;
      release(): void;
      retain(submission: RHISubmission): void;
    }>
  | Readonly<{
      source: 'webgl-fragment';
      lights: RHITexture;
      receivers: RHITexture;
      receiverCount: number;
      maxTextureDimension2D: number;
      recorder: PreparedWebGlLightListRecorder;
      forwardBindGroupLayoutToken: PreparedBindGroupLayoutToken;
      forwardBindGroupLayout: RHIBindGroupLayout;
      environmentBuffer: RHIBuffer;
      irradianceMap: RHITexture;
      prefilteredRadianceMap: RHITexture;
      environmentBrdfLut: RHITexture;
      release(): void;
      retain(submission: RHISubmission): void;
    }>;

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
      renderPasses: number;
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
      /** Prepared LightList input for standard-lit packets; legacy/custom packets may omit it. */
      lightList?: BaselineLightListFrame;
      postColor?: BaselinePostColorPreparation;
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
  /** Optional pre-cooked real environment asset; if omitted, defaults to synthetic fallback. */
  readonly environment?: EnvironmentAsset | undefined;
}
