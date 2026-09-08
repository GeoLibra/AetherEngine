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
import type { PreparedBackgroundFrame } from '../../background/prepare';
import type { ViewBackground } from '../../background/types';

/** Environment resources consumed by forward IBL shading. */
export interface BaselineEnvironmentFrame {
  readonly buffer: RHIBuffer;
  readonly irradianceMap: RHITexture;
  readonly prefilteredRadianceMap: RHITexture;
  readonly environmentBrdfLut: RHITexture;
}

/** Submission-scoped LightList inputs consumed by forward shading. */
export type BaselineLightListFrame =
  | Readonly<{
      source: 'gpu-compute';
      lights: RHIBuffer;
      receivers: RHIBuffer;
      receiverCount: number;
      recorder: PreparedWebGpuLightListRecorder;
      forwardBindGroupLayoutToken: PreparedBindGroupLayoutToken;
      forwardBindGroupLayout: RHIBindGroupLayout;
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
      /** Environment resources consumed by forward IBL shading. */
      environment?: BaselineEnvironmentFrame;
      /** Prepared fullscreen background (skybox/solid/panorama). */
      background?: PreparedBackgroundFrame;
      /** Prepared LightList input for standard-lit packets; legacy/custom packets may omit it. */
      lightList?: BaselineLightListFrame;
      postColor?: BaselinePostColorPreparation;
      deviceGeneration: number;
      surfaceGeneration: number;
    }>;

/** Shared environment lighting parameters consumed consistently by forward IBL and Skybox background. */
export interface BaselineEnvironmentLighting {
  /** Overall radiance multiplier. Defaults to 1.0. */
  readonly intensity?: number;
  /** Linear RGB radiance tint for specular IBL and skybox. Defaults to [1, 1, 1]. */
  readonly radianceTint?: readonly [number, number, number];
  /** Linear RGB diffuse irradiance tint. Defaults to [1, 1, 1]. */
  readonly diffuseIrradiance?: readonly [number, number, number];
}

/** Structured environment configuration combining an asset with explicit lighting options. */
export interface BaselineEnvironmentOptions {
  readonly asset: EnvironmentAsset;
  readonly lighting?: BaselineEnvironmentLighting | undefined;
}

/** Fully normalized environment lighting configuration with defaults applied. */
export interface NormalizedBaselineEnvironmentLighting {
  readonly intensity: number;
  readonly radianceTint: readonly [number, number, number];
  readonly diffuseIrradiance: readonly [number, number, number];
}

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
  /** Optional pre-cooked real environment asset or full environment configuration; if omitted, defaults to synthetic fallback. */
  readonly environment?: EnvironmentAsset | BaselineEnvironmentOptions | undefined;
  /** Optional shared environment lighting configuration overriding defaults for both IBL and Skybox. */
  readonly environmentLighting?: BaselineEnvironmentLighting | undefined;
  /** Optional view background configuration (skybox/solid/none). */
  readonly background?: ViewBackground | undefined;
  /** Optional toggle to force separate physical passes instead of merging. */
  readonly forceSeparatePasses?: boolean | undefined;
}
