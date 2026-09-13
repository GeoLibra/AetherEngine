import type { AssetImportContext, AssetSource } from '../../importer/types';
import type { GLTFWithBuffers, LoadersGLParserBinding, LoadersGLParseResult } from './types';
import { createVfsFetchBridge } from './loaders-gl-vfs';

export interface LoadersGLBridgeOptions {
  /** Injected loaders.gl parse function: (data, loaders, options, context) => Promise<any> */
  readonly parseFn?: (
    data: any,
    loaders: readonly any[],
    options?: Record<string, any>,
    context?: any
  ) => Promise<GLTFWithBuffers>;
  /** Injected GLTFLoader object from @loaders.gl/gltf */
  readonly gltfLoader?: unknown;
}

/**
 * Bridge implementation that delegates parsing to loaders.gl's GLTFLoader.
 * When loaders.gl is passed/injected, it handles container extraction, Draco, and subloaders,
 * while routing all IO requests safely through Aether VFS via createVfsFetchBridge.
 */
export class LoadersGLGltfBinding implements LoadersGLParserBinding<GLTFWithBuffers> {
  readonly id = 'loaders.gl.gltf';
  readonly loaders: readonly unknown[];
  private readonly parseFn:
    | ((
        data: any,
        loaders: readonly any[],
        options?: Record<string, any>,
        context?: any
      ) => Promise<GLTFWithBuffers>)
    | undefined;

  constructor(options: LoadersGLBridgeOptions = {}) {
    this.loaders = options.gltfLoader ? [options.gltfLoader] : [];
    this.parseFn = options.parseFn;
  }

  async parse(
    source: AssetSource,
    context: AssetImportContext
  ): Promise<LoadersGLParseResult<GLTFWithBuffers>> {
    if (!this.parseFn) {
      throw new Error(
        'LoadersGLGltfBinding requires an injected loaders.gl parse function (e.g. from @loaders.gl/core).'
      );
    }

    const buffer = source.buffer ?? (await context.dependencies.load(source.uri, context.signal));

    const vfsFetch = createVfsFetchBridge(source.uri, context);

    const data = await this.parseFn(buffer, this.loaders, {
      fetch: vfsFetch,
      gltf: {
        loadBuffers: true,
        loadImages: false, // Images are resolved and loaded via Aether VFS during cook/prepare
        decompressMeshes: true
      }
    });

    return {
      data,
      readBytes: buffer.byteLength
    };
  }
}
