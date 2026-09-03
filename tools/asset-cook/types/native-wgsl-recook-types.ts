import type { CookNodeId } from '../../../src/assets/cook';
import type { NativeWgslCooker } from '../../shader-cooker';

/** Node-only adapter construction options. */
export interface NativeWgslRecookAdapterOptions {
  readonly nativeCooker: NativeWgslCooker;
  readonly packageToolchain: Readonly<{ id: string; version: string }>;
}

/** Stable source and package policy registered for one shader cook node. */
export interface NativeWgslRecookSource {
  readonly nodeId: CookNodeId;
  readonly sourcePath: string;
  readonly sourceUri: string;
  readonly metadataPath?: string;
  readonly dependencies: readonly CookNodeId[];
  readonly shaderAbiVersion: number;
  readonly sourceLanguageVersion: string;
  readonly metadataSchemaVersion: number;
}
