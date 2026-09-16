/**
 * @file Compiles and prepares render pipeline and bind group layouts for Skybox / HDR Background.
 */

import { SKYBOX_SHADER_MODULE } from '../../../shader';
import type {
  GPUTextureFormat,
  RHIBindGroupLayout,
  RHIDevice,
  RHIRenderPipeline,
  RHIResource,
  RHISampler
} from '../../../rhi/contracts';
import type { RHISubmission } from '../../../rhi/contracts';
import { SubmissionRetainedValue } from '../../world/submission-retained-value';
import {
  createPreparedToken,
  type PreparedBindGroupLayoutToken,
  type PreparedRenderPipelineToken
} from '../../../render-graph';
import { SKYBOX_UNIFORM_BYTE_SIZE } from './background-uniforms';

export interface BackgroundPipelineOptions {
  readonly colorFormat: GPUTextureFormat;
  readonly depthFormat?: GPUTextureFormat | undefined;
  readonly label?: string | undefined;
}

export interface PreparedBackgroundPipeline {
  readonly pipelineToken: PreparedRenderPipelineToken;
  readonly uniformLayoutToken: PreparedBindGroupLayoutToken;
  readonly textureLayoutToken: PreparedBindGroupLayoutToken;
  readonly pipeline: RHIRenderPipeline;
  readonly uniformLayout: RHIBindGroupLayout;
  readonly textureLayout: RHIBindGroupLayout;
  readonly sampler: RHISampler;
}

interface CachedBackgroundPipeline {
  readonly deviceGeneration: number;
  readonly prepared: PreparedBackgroundPipeline;
  readonly ownedResources: readonly RHIResource[];
  readonly retention: SubmissionRetainedValue<readonly RHIResource[]>;
}

const devicePipelineCaches = new WeakMap<RHIDevice, Map<string, CachedBackgroundPipeline>>();

/**
 * Disposes all cached background pipeline resources associated with the specified device.
 * Enforces targeted lifecycle management so one device's teardown does not affect
 * other concurrently active devices.
 *
 * @param device The device whose background pipeline cache should be cleared.
 */
export function clearBackgroundPipelineCache(device: RHIDevice): void {
  const cache = devicePipelineCaches.get(device);
  if (cache === undefined) return;
  for (const cached of cache.values()) {
    cached.retention.retire();
  }
  cache.clear();
}

/**
 * Creates or retrieves the cached Skybox fullscreen pipeline, sampler, and layouts
 * matching the attached color & depth formats scoped to the specified RHIDevice.
 */
export function prepareBackgroundPipeline(
  device: RHIDevice,
  options: BackgroundPipelineOptions
): Readonly<{
  prepared: PreparedBackgroundPipeline;
  ownedResources: readonly RHIResource[];
  retain(submission: RHISubmission): void;
  release(): void;
}> {
  let deviceCache = devicePipelineCaches.get(device);
  if (deviceCache === undefined) {
    deviceCache = new Map<string, CachedBackgroundPipeline>();
    devicePipelineCaches.set(device, deviceCache);
    void device.lost.then(() => clearBackgroundPipelineCache(device));
  }

  const cacheKey = `${options.colorFormat}:${options.depthFormat ?? 'none'}`;
  const existing = deviceCache.get(cacheKey);
  if (existing !== undefined && existing.deviceGeneration === device.generation) {
    return leasePipeline(existing);
  }

  // Purge stale records on this device if device generation changed
  if (existing !== undefined && existing.deviceGeneration !== device.generation) {
    for (const [key, record] of deviceCache.entries()) {
      if (record.deviceGeneration !== device.generation) {
        record.retention.retire();
        deviceCache.delete(key);
      }
    }
  }

  const label = options.label ?? 'aether-skybox';

  const shader = device.createShaderModule({
    label: `${label}-shader`,
    code: SKYBOX_SHADER_MODULE
  });

  // Group 0: SkyboxUniforms (accessible in vertex and fragment stages)
  const uniformLayout = device.createBindGroupLayout({
    label: `${label}-uniform-layout`,
    entries: [
      {
        binding: 0,
        visibility: (1 << 0) | (1 << 1), // VERTEX | FRAGMENT
        buffer: { type: 'uniform', minBindingSize: SKYBOX_UNIFORM_BYTE_SIZE }
      }
    ]
  });

  // Group 1: Texture & Sampler (fragment stage)
  const textureLayout = device.createBindGroupLayout({
    label: `${label}-texture-layout`,
    entries: [
      { binding: 0, visibility: 1 << 1, texture: { sampleType: 'float' } },
      { binding: 1, visibility: 1 << 1, sampler: { type: 'filtering' } }
    ]
  });

  const layout = device.createPipelineLayout({
    label: `${label}-pipeline-layout`,
    bindGroupLayouts: [uniformLayout, textureLayout]
  });

  const sampler = device.createSampler({
    label: `${label}-sampler`,
    magFilter: 'linear',
    minFilter: 'linear',
    mipmapFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'clamp-to-edge'
  });

  const pipeline = device.createRenderPipeline({
    label: `${label}-pipeline`,
    layout,
    vertex: {
      module: shader,
      entryPoint: 'skyboxVertex'
    },
    primitive: {
      topology: 'triangle-list',
      frontFace: 'ccw',
      cullMode: 'none'
    },
    fragment: {
      module: shader,
      entryPoint: 'skyboxFragment',
      targets: [{ format: options.colorFormat }]
    },
    ...(options.depthFormat !== undefined
      ? {
          depthStencil: {
            format: options.depthFormat,
            depthWriteEnabled: false,
            depthCompare: 'always'
          }
        }
      : {})
  });

  const pipelineToken = createPreparedToken('render-pipeline', label);
  const uniformLayoutToken = createPreparedToken('bind-group-layout', `${label}-uniform-layout`);
  const textureLayoutToken = createPreparedToken('bind-group-layout', `${label}-texture-layout`);

  const prepared = Object.freeze({
    pipelineToken,
    uniformLayoutToken,
    textureLayoutToken,
    pipeline,
    uniformLayout,
    textureLayout,
    sampler
  });
  const ownedResources = Object.freeze([
    shader,
    uniformLayout,
    textureLayout,
    layout,
    sampler,
    pipeline
  ]);

  const entry = Object.freeze({
    deviceGeneration: device.generation,
    prepared,
    ownedResources,
    retention: new SubmissionRetainedValue<readonly RHIResource[]>(ownedResources, (resources) => {
      for (const resource of [...resources].reverse()) resource.dispose();
    })
  });
  deviceCache.set(cacheKey, entry);
  return leasePipeline(entry);
}

function leasePipeline(entry: CachedBackgroundPipeline) {
  const lease = entry.retention.acquire();
  if (lease === undefined) throw new Error('Background pipeline cache contains a retired entry.');
  return Object.freeze({
    prepared: entry.prepared,
    ownedResources: entry.ownedResources,
    retain: (submission: RHISubmission) => lease.retain(submission),
    release: () => lease.release()
  });
}
