import type { CanonicalVFSUri } from './vfs-types';

/** Caller-owned bytes and identity metadata inserted into a memory provider. */
export interface MemoryVFSProviderEntry {
  readonly bytes: Uint8Array;
  readonly resolvedUri: CanonicalVFSUri;
  readonly revision: string;
  readonly mime?: string;
  readonly integrity?: string;
}
