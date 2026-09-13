import type { AssetImportContext, AssetSource } from '../../../importer/types';

/**
 * Raw container result structure as returned by loaders.gl GLTFLoader or raw GLB parser.
 */
export interface GLTFWithBuffers {
  readonly json: Record<string, any>;
  readonly buffers: readonly Uint8Array[];
  readonly binary?: Uint8Array;
  readonly images?: readonly Uint8Array[];
}

export interface LoadersGLParseResult<TParsed> {
  readonly data: TParsed;
  readonly readBytes: number;
}

/**
 * Interface isolating loaders.gl loader invocation from Aether runtime.
 */
export interface LoadersGLParserBinding<TParsed> {
  readonly id: string;
  readonly loaders: readonly unknown[];

  parse(source: AssetSource, context: AssetImportContext): Promise<LoadersGLParseResult<TParsed>>;
}
