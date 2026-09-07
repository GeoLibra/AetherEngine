/**
 * @file Prepares GPU resources and pipeline state for Skybox / HDR Background fullscreen pass.
 * Conforms to engine/design/v2/04-rendering/10-skybox-background.md.
 */

import { Mat4, Quat, type Quaternion } from '../../../math';
import type {
  GPUTextureFormat,
  RHIBindGroupLayout,
  RHIBuffer,
  RHIDevice,
  RHIRenderPipeline,
  RHIResource,
  RHISampler,
  RHISubmission,
  RHITexture
} from '../../../rhi/contracts';
import type {
  PreparedBindGroupLayoutToken,
  PreparedRenderPipelineToken
} from '../../../render-graph';
import type { EnvironmentAsset } from '../../../assets/environment';
import type { EnvironmentTextureCache } from '../../lighting/environment/environment-cache';
import type { ExtractedView } from '../../camera';
import { computeFullscreenVertexDirections, extractCameraRotationMatrix } from '../coordinates';
import { BackgroundDiagnosticCodes, BackgroundDiagnosticError } from '../diagnostics';
import type { ViewBackground } from '../types';
import { prepareBackgroundPipeline } from './background-pipeline';
import { packSkyboxUniforms, SKYBOX_UNIFORM_BYTE_SIZE } from './background-uniforms';

const UNIFORM_BUFFER_USAGE = (1 << 3) | (1 << 6); // UNIFORM | COPY_DST
const SAMPLED_TEXTURE_USAGE = (1 << 1) | (1 << 2); // TEXTURE_BINDING | COPY_DST

const dummyTextureCache = new WeakMap<RHIDevice, RHITexture>();

function getOrCreateDummyTexture(device: RHIDevice): RHITexture {
  const existing = dummyTextureCache.get(device);
  if (existing !== undefined && existing.state === 'live') {
    return existing;
  }
  const texture = device.createTexture({
    label: 'aether-skybox-dummy-texture',
    size: [1, 1],
    format: 'rgba16float',
    usage: SAMPLED_TEXTURE_USAGE
  });
  device.queue.writeTexture(
    { texture },
    new Uint16Array([0, 0, 0, 15360]), // 1.0 in FP16
    { bytesPerRow: 8, rowsPerImage: 1 },
    { width: 1, height: 1 }
  );
  dummyTextureCache.set(device, texture);
  return texture;
}

export interface PrepareBackgroundOptions {
  readonly device: RHIDevice;
  readonly view: ExtractedView;
  readonly background: ViewBackground;
  readonly colorFormat: GPUTextureFormat;
  readonly depthFormat?: GPUTextureFormat | undefined;
  readonly environmentAsset?: EnvironmentAsset | undefined;
  readonly environmentCache: EnvironmentTextureCache;
  readonly environmentRotation?: Quaternion | undefined;
  readonly depthMode?: 'standard' | 'reverse' | undefined;
  readonly reconstructionMode?: 'vertex' | 'fragment' | undefined;
}

export interface PreparedBackgroundFrame {
  readonly status: 'ready' | 'none';
  readonly representation?: 'panorama' | 'radiance-level-zero' | 'solid';
  readonly pipelineToken?: PreparedRenderPipelineToken;
  readonly uniformLayoutToken?: PreparedBindGroupLayoutToken;
  readonly textureLayoutToken?: PreparedBindGroupLayoutToken;
  readonly pipeline?: RHIRenderPipeline;
  readonly uniformLayout?: RHIBindGroupLayout;
  readonly textureLayout?: RHIBindGroupLayout;
  readonly uniformBuffer?: RHIBuffer;
  readonly texture?: RHITexture;
  readonly sampler?: RHISampler;
  readonly ownedResources?: readonly RHIResource[];
  retain(submission?: RHISubmission): void;
  release(): void;
}

/**
 * Prepares background GPU uniforms, pipeline, and textures for the frame.
 */
export function prepareBackground(options: PrepareBackgroundOptions): PreparedBackgroundFrame {
  const {
    device,
    view,
    background,
    colorFormat,
    depthFormat,
    environmentAsset,
    environmentCache,
    environmentRotation,
    depthMode = 'standard',
    reconstructionMode = 'vertex'
  } = options;

  if (background.kind === 'inherit') {
    throw new BackgroundDiagnosticError(
      BackgroundDiagnosticCodes.CompositionInvalid,
      'Background kind "inherit" must be resolved at view composition boundary before preparation.',
      { viewId: view.viewId, stage: 'preparation' }
    );
  }

  if (background.kind === 'none') {
    return {
      status: 'none',
      retain: () => {},
      release: () => {}
    };
  }

  let texture: RHITexture;
  let maxLod = 0;
  let textureWidth = 1;
  let textureHeight = 1;
  let intensity = 1.0;
  let multiplier = 1.0;
  let bundleRelease: (() => void) | undefined;
  let bundleRetain: ((sub?: RHISubmission) => void) | undefined;

  if (background.kind === 'solid') {
    texture = getOrCreateDummyTexture(device);
  } else if (background.kind === 'environment') {
    if (environmentAsset === undefined) {
      throw new BackgroundDiagnosticError(
        'background-environment-missing',
        'Environment background requested but no environment asset is selected.',
        { viewId: view.viewId }
      );
    }
    const bundle = environmentCache.acquireBackground(
      device,
      environmentAsset,
      background.representation
    );
    texture = bundle.texture;
    maxLod = bundle.maxLod;
    intensity = 1.0;
    multiplier = background.multiplier;
    bundleRelease = () => bundle.release();
    bundleRetain = (sub?: RHISubmission) => bundle.retain(sub);

    if (background.representation === 'panorama') {
      if (
        environmentAsset.artifact.schema === 'EnvironmentArtifact@2' &&
        environmentAsset.artifact.background.kind === 'panorama'
      ) {
        const base = environmentAsset.artifact.background.payload.levels[0]!;
        textureWidth = base.width;
        textureHeight = base.height;
      }
    } else {
      const base = environmentAsset.artifact.radiance.levels[0]!;
      textureWidth = base.width;
      textureHeight = base.height;
    }
  } else {
    return {
      status: 'none',
      retain: () => {},
      release: () => {}
    };
  }

  // 1. Pipeline and layout compilation
  const { prepared: pipelinePrep, ownedResources } = prepareBackgroundPipeline(device, {
    colorFormat,
    depthFormat,
    label: `skybox-${view.viewId}`
  });

  // 2. Compute vertex rays & camera matrices
  const vertexRays = computeFullscreenVertexDirections({
    viewMatrix: view.view,
    projectionMatrix: view.projection,
    projectionKind: view.projectionKind,
    depthMode,
    environmentRotation
  });

  const invProj = Mat4.invert(view.projection);
  const camRot = extractCameraRotationMatrix(view.view);
  let envRot = camRot;
  if (environmentRotation !== undefined) {
    const invEnv = Quat.invert(environmentRotation);
    const envMat = Mat4.fromTRS([0, 0, 0], invEnv, [1, 1, 1]);
    envRot = Mat4.multiply(envMat, camRot);
  }

  // 3. Pack uniforms
  const packedData = packSkyboxUniforms({
    vertexRays,
    invProj,
    envRot,
    intensity,
    multiplier,
    maxLod,
    textureWidth,
    textureHeight,
    reconstructionMode,
    representation: background.kind === 'solid' ? 'solid' : background.representation,
    depthMode,
    projectionKind: view.projectionKind,
    solidColor: background.kind === 'solid' ? background.colorLinear : undefined
  });

  const uniformBuffer = device.createBuffer({
    label: `skybox-uniforms-${view.viewId}`,
    size: SKYBOX_UNIFORM_BYTE_SIZE,
    usage: UNIFORM_BUFFER_USAGE
  });
  device.queue.writeBuffer(uniformBuffer, 0, packedData);

  let released = false;
  let retained = false;
  const pendingSubmissions = new Set<Promise<unknown>>();

  return Object.freeze({
    status: 'ready',
    representation: background.kind === 'solid' ? 'solid' : background.representation,
    pipelineToken: pipelinePrep.pipelineToken,
    uniformLayoutToken: pipelinePrep.uniformLayoutToken,
    textureLayoutToken: pipelinePrep.textureLayoutToken,
    pipeline: pipelinePrep.pipeline,
    uniformLayout: pipelinePrep.uniformLayout,
    textureLayout: pipelinePrep.textureLayout,
    uniformBuffer,
    texture,
    sampler: pipelinePrep.sampler,
    ownedResources: Object.freeze([uniformBuffer]),
    retain(submission?: RHISubmission) {
      bundleRetain?.(submission);
      if (submission !== undefined && !retained) {
        retained = true;
        const pending = submission.done.finally(() => {
          uniformBuffer.dispose();
          pendingSubmissions.delete(pending);
        });
        pendingSubmissions.add(pending);
      }
    },
    release() {
      if (released) return;
      released = true;
      if (!retained) {
        uniformBuffer.dispose();
      }
      bundleRelease?.();
    }
  });
}
