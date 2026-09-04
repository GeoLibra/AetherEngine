import type {
  MemoryVFSProviderEntry,
  NormalizedMountPath,
  VFSProvider,
  VFSProviderCapabilities,
  VFSProviderId,
  VFSProviderReadResult,
  VFSReadOptions
} from '../types';
import { normalizeVFSUri, toNormalizedMountPath } from '../uri';

const MEMORY_CAPABILITIES: VFSProviderCapabilities = Object.freeze({
  read: true,
  range: false,
  write: false,
  watch: false
});

/** Validates a stable provider identity at its construction boundary. */
export function defineVFSProviderId(value: string): VFSProviderId {
  if (!value) throw new Error('VFS provider id must be a non-empty string.');
  return value as VFSProviderId;
}

/** Deterministic owned-byte provider for headless use and VFS contract tests. */
export class MemoryVFSProvider implements VFSProvider {
  readonly id: VFSProviderId;
  readonly capabilities = MEMORY_CAPABILITIES;
  readonly #entries = new Map<NormalizedMountPath, MemoryVFSProviderEntry>();

  constructor(id: string) {
    this.id = defineVFSProviderId(id);
  }

  /** Inserts or replaces one provider-relative path after taking byte ownership. */
  put(path: NormalizedMountPath, entry: MemoryVFSProviderEntry): void {
    validatePath(path);
    const snapshot: MemoryVFSProviderEntry = {
      bytes: new Uint8Array(entry.bytes),
      resolvedUri: entry.resolvedUri,
      revision: entry.revision,
      ...(entry.mime === undefined ? {} : { mime: entry.mime }),
      ...(entry.integrity === undefined ? {} : { integrity: entry.integrity })
    };
    if (!snapshot.revision) throw new Error('Memory VFS entry revision must be non-empty.');
    if (normalizeVFSUri(snapshot.resolvedUri) !== snapshot.resolvedUri) {
      throw new Error('Memory VFS resolved URI must be canonical.');
    }
    this.#entries.set(path, snapshot);
  }

  /** Deletes one entry and reports whether it existed. */
  delete(path: NormalizedMountPath): boolean {
    validatePath(path);
    return this.#entries.delete(path);
  }

  /** Returns a detached full-read payload or a typed expected failure. */
  async read(path: NormalizedMountPath, options: VFSReadOptions): Promise<VFSProviderReadResult> {
    validatePath(path);
    if (options.signal?.aborted) {
      return Object.freeze({
        kind: 'aborted',
        code: 'vfs-read-aborted',
        message: 'VFS read was aborted.'
      });
    }
    const entry = this.#entries.get(path);
    if (!entry) {
      return Object.freeze({
        kind: 'not-found',
        code: 'vfs-memory-not-found',
        message: 'Memory VFS entry was not found.'
      });
    }
    const bytes = entry.bytes.slice();
    return Object.freeze({
      kind: 'success',
      bytes,
      resolvedUri: entry.resolvedUri,
      revision: entry.revision,
      contentLength: bytes.byteLength,
      providerId: this.id,
      ...(entry.mime === undefined ? {} : { mime: entry.mime }),
      ...(entry.integrity === undefined ? {} : { integrity: entry.integrity })
    });
  }
}

function validatePath(path: NormalizedMountPath): void {
  if (!path.startsWith('/') || path.includes('//') || path.includes('\\') || path.includes('\0')) {
    throw new Error('Memory VFS path must be normalized and rooted.');
  }
  toNormalizedMountPath(path === '/' ? [] : path.slice(1).split('/'));
}
