import type { RHIDevice, RHISampler, RHITexture } from '../../rhi/contracts';
import type {
  StandardLitResolvedTexture,
  StandardLitResourceResolver
} from '../../rendering/material/standard-lit-textures';
import type { CookedSamplerArtifact, CookedTextureArtifact } from './types';
import {
  createDefaultBlackSrgbTexture,
  createDefaultFlatNormalTexture,
  createDefaultLinearRepeatSampler,
  createDefaultWhiteDataTexture,
  createDefaultWhiteSrgbTexture
} from './texture-cooker';

const TEXTURE_USAGE = (1 << 1) | (1 << 2); // CopyDestination | TextureBinding

/**
 * Registry that holds cooked texture/sampler artifacts and prepares them as live RHI resources.
 * Implements StandardLitResourceResolver for zero-cost integration into render passes.
 */
export class CookedTextureRegistry implements StandardLitResourceResolver {
  private readonly textureArtifacts = new Map<string, CookedTextureArtifact>();
  private readonly samplerArtifacts = new Map<string, CookedSamplerArtifact>();

  private readonly preparedTextures = new Map<string, RHITexture>();
  private readonly preparedSamplers = new Map<string, RHISampler>();
  private currentDeviceGeneration = -1;

  constructor() {
    // Register standard default builtins
    this.registerTexture(createDefaultWhiteSrgbTexture());
    this.registerTexture(createDefaultWhiteDataTexture());
    this.registerTexture(createDefaultFlatNormalTexture());
    this.registerTexture(createDefaultBlackSrgbTexture());
    this.registerSampler(createDefaultLinearRepeatSampler());
  }

  registerTexture(artifact: CookedTextureArtifact): void {
    this.textureArtifacts.set(artifact.id, artifact);
  }

  registerSampler(artifact: CookedSamplerArtifact): void {
    this.samplerArtifacts.set(artifact.id, artifact);
  }

  /**
   * Prepares all registered texture and sampler artifacts for the given live RHI device.
   * Invalidates and rebuilds GPU resources if the device generation changes (e.g. after device loss).
   */
  prepare(device: RHIDevice): void {
    if (this.currentDeviceGeneration !== device.generation) {
      this.disposePrepared();
      this.currentDeviceGeneration = device.generation;
    }

    // 1. Prepare textures
    for (const [id, artifact] of this.textureArtifacts.entries()) {
      if (!this.preparedTextures.has(id)) {
        const texture = device.createTexture({
          label: `texture:${id}:${artifact.role}`,
          size: [artifact.width, artifact.height],
          format: artifact.format,
          usage: TEXTURE_USAGE
        });

        const bytesPerRow = artifact.width * 4;
        device.queue.writeTexture(
          { texture },
          artifact.data,
          { bytesPerRow, rowsPerImage: artifact.height },
          { width: artifact.width, height: artifact.height }
        );

        this.preparedTextures.set(id, texture);
      }
    }

    // 2. Prepare samplers
    for (const [id, artifact] of this.samplerArtifacts.entries()) {
      if (!this.preparedSamplers.has(id)) {
        const sampler = device.createSampler({
          magFilter: artifact.magFilter,
          minFilter: artifact.minFilter,
          mipmapFilter: artifact.mipmapFilter,
          addressModeU:
            artifact.addressModeU === 'mirrored-repeat' ? 'mirror-repeat' : artifact.addressModeU,
          addressModeV:
            artifact.addressModeV === 'mirrored-repeat' ? 'mirror-repeat' : artifact.addressModeV
        });
        this.preparedSamplers.set(id, sampler);
      }
    }
  }

  resolveTexture(assetId: string): StandardLitResolvedTexture | undefined {
    let texture = this.preparedTextures.get(assetId);
    let artifact = this.textureArtifacts.get(assetId);

    if (!texture || !artifact) {
      for (const [id, art] of this.textureArtifacts.entries()) {
        if (id.startsWith(`${assetId}:`)) {
          texture = this.preparedTextures.get(id);
          artifact = art;
          break;
        }
      }
    }

    if (!texture || !artifact) return undefined;

    return {
      texture,
      semantic: artifact.semantic
    };
  }

  resolveSampler(assetId: string): RHISampler | undefined {
    return this.preparedSamplers.get(assetId);
  }

  dispose(): void {
    this.disposePrepared();
    this.textureArtifacts.clear();
    this.samplerArtifacts.clear();
  }

  private disposePrepared(): void {
    for (const texture of this.preparedTextures.values()) {
      texture.dispose();
    }
    this.preparedTextures.clear();

    for (const sampler of this.preparedSamplers.values()) {
      sampler.dispose();
    }
    this.preparedSamplers.clear();
  }
}
