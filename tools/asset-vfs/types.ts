import type { CanonicalVFSUri } from '../../src/assets/vfs';

/** Construction input for the Node-only full-read filesystem provider. */
export interface FileSystemVFSProviderOptions {
  readonly id: string;
  readonly rootDirectory: string;
  readonly resolvedRootUri: CanonicalVFSUri;
}
