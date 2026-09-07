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
import {
  createPreparedBindGroupLayoutToken,
  createPreparedRenderPipelineToken,
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
}

const pipelineCache = new Map<string, CachedBackgroundPipeline>();

/**
 * Disposes all cached background pipeline resources across all devices.
 */
export function clearBackgroundPipelineCache(): void {
  for (const cached of pipelineCache.values()) {
    for (const resource of [...cached.ownedResources].reverse()) {
      resource.dispose();
    }
  }
  pipelineCache.clear();
}

/**
 * Creates or retrieves the cached Skybox fullscreen pipeline, sampler, and layouts
 * matching the attached color & depth formats for the current device generation.
 */
export function prepareBackgroundPipeline(
  device: RHIDevice,
  options: BackgroundPipelineOptions
): Readonly<{
  prepared: PreparedBackgroundPipeline;
  ownedResources: readonly RHIResource[];
}> {
  const cacheKey = `${device.generation}:${options.colorFormat}:${options.depthFormat ?? 'none'}`;
  const existing = pipelineCache.get(cacheKey);
  if (existing !== undefined && existing.deviceGeneration === device.generation) {
    return Object.freeze({
      prepared: existing.prepared,
      ownedResources: existing.ownedResources
    });
  }

  // Purge stale device generation records
  for (const [key, record] of pipelineCache.entries()) {
    if (record.deviceGeneration !== device.generation) {
      for (const res of [...record.ownedResources].reverse()) {
        res.dispose();
      }
      pipelineCache.delete(key);
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

  const pipelineToken = createPreparedRenderPipelineToken(label);
  const uniformLayoutToken = createPreparedBindGroupLayoutToken(`${label}-uniform-layout`);
  const textureLayoutToken = createPreparedBindGroupLayoutToken(`${label}-texture-layout`);

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

  pipelineCache.set(
    cacheKey,
    Object.freeze({
      deviceGeneration: device.generation,
      prepared,
      ownedResources
    })
  );

  return Object.freeze({
    prepared,
    ownedResources
  });
}
