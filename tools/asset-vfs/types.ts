/** @file Types and options for the IndexedDB Virtual File System provider. */

import type { CanonicalVFSUri } from '../../src/assets/vfs';

/**
 * Construction input for the browser IndexedDB full-read VFS provider.
 */
export interface IndexedDbVFSProviderOptions {
  /**
   * Logical provider identifier used for telemetry and error provenance.
   *
   * Must be a non-empty string.
   */
  readonly id: string;

  /**
   * Target IndexedDB database name containing the version-1 `files` object store.
   *
   * Must be a non-empty string.
   */
  readonly databaseName: string;

  /**
   * Validated canonical URI representing the root mount point of this provider.
   *
   * Traversal outside this canonical root is strictly prohibited.
   */
  readonly resolvedRootUri: CanonicalVFSUri;

  /**
   * Injected IndexedDB factory instance.
   *
   * Allows passing `window.indexedDB` in browser runtimes or `fake-indexeddb` in headless tests.
   */
  readonly indexedDB: IDBFactory;
}
