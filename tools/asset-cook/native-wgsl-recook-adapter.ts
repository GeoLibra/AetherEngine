/** @file Connects registered WGSL authoring sources to the generic shader recook port. */

import { encodeCookedShaderArtifactPackage } from '../../src/assets';
import type { CookNodeId, ShaderCookResult, ShaderCookerPort } from '../../src/assets/cook';
import type { NativeWgslRecookAdapterOptions, NativeWgslRecookSource } from './types';

/** Node-only shader cooker port backed by the existing native Naga adapter. */
export class NativeWgslRecookAdapter implements ShaderCookerPort {
  readonly #sources = new Map<CookNodeId, NativeWgslRecookSource>();
  readonly #nativeCooker: NativeWgslRecookAdapterOptions['nativeCooker'];
  readonly #packageToolchain: NativeWgslRecookAdapterOptions['packageToolchain'];

  constructor(options: NativeWgslRecookAdapterOptions) {
    this.#nativeCooker = options.nativeCooker;
    this.#packageToolchain = Object.freeze({ ...options.packageToolchain });
  }

  /** Registers immutable authoring and package configuration for a stable node. */
  register(source: NativeWgslRecookSource): void {
    if (this.#sources.has(source.nodeId)) {
      throw new Error(`Shader cook source is already registered: ${source.nodeId}`);
    }
    this.#sources.set(
      source.nodeId,
      Object.freeze({ ...source, dependencies: Object.freeze([...source.dependencies]) })
    );
  }

  /** Invokes native Naga cooking and wraps the validated result in the package ABI. */
  async cook(nodeId: CookNodeId, _revision: number): Promise<ShaderCookResult> {
    const source = this.#sources.get(nodeId);
    if (!source) throw new Error(`Shader cook source is not registered: ${nodeId}`);
    const artifact = await this.#nativeCooker.cook({
      sourcePath: source.sourcePath,
      sourceUri: source.sourceUri,
      ...(source.metadataPath === undefined ? {} : { metadataPath: source.metadataPath })
    });
    const bundle = await encodeCookedShaderArtifactPackage(artifact, {
      shaderAbiVersion: source.shaderAbiVersion,
      sourceLanguageVersion: source.sourceLanguageVersion,
      metadataSchemaVersion: source.metadataSchemaVersion,
      packageToolchain: this.#packageToolchain
    });
    return Object.freeze({
      bundle,
      dependencies: source.dependencies,
      inputHashes: Object.freeze([artifact.source.contentHash]),
      toolchainVersion: `${artifact.toolchain.cookerId}@${artifact.toolchain.cookerVersion}+naga@${artifact.toolchain.nagaVersion}`
    });
  }
}
