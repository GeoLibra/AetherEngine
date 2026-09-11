import { sliceRangeBytes, validateByteRange } from '../range';
import { createVFSStreamSession } from '../stream';
import type {
  ByteRange,
  MemoryVFSProviderEntry,
  NormalizedMountPath,
  VFSProvider,
  VFSProviderCapabilities,
  VFSProviderId,
  VFSProviderRangeReadResult,
  VFSProviderReadResult,
  VFSProviderStreamOpenResult,
  VFSReadOptions,
  VFSStreamOptions
} from '../types';
import { normalizeVFSUri, toNormalizedMountPath } from '../uri';

export interface MemoryVFSProviderOptions {
  readonly enableRange?: boolean;
  readonly enableStream?: boolean;
  readonly streamChunkBytes?: number;
}

/** Validates a stable provider identity at its construction boundary. */
export function defineVFSProviderId(value: string): VFSProviderId {
  if (!value) throw new Error('VFS provider id must be a non-empty string.');
  return value as VFSProviderId;
}

/** Deterministic owned-byte provider for headless use and VFS contract tests. */
export class MemoryVFSProvider implements VFSProvider {
  readonly id: VFSProviderId;
  readonly capabilities: VFSProviderCapabilities;
  readonly #streamChunkBytes: number;
  readonly #entries = new Map<NormalizedMountPath, MemoryVFSProviderEntry>();

  constructor(id: string, options?: MemoryVFSProviderOptions) {
    this.id = defineVFSProviderId(id);
    const range = options?.enableRange ?? false;
    const stream = options?.enableStream ?? false;
    this.#streamChunkBytes = options?.streamChunkBytes ?? 64 * 1024;
    this.capabilities = Object.freeze({
      read: true,
      range,
      stream,
      write: false,
      watch: false
    });
  }

  /** Inserts or replaces one provider-relative path after taking byte ownership. */
  put(path: NormalizedMountPath, entry: MemoryVFSProviderEntry): void {
    validatePath(path);
    // Read each caller property exactly once before constructing the snapshot.
    const rawBytes = entry.bytes;
    const resolvedUri = entry.resolvedUri;
    const revision = entry.revision;
    const mime = entry.mime;
    const integrity = entry.integrity;

    const snapshot: MemoryVFSProviderEntry = {
      bytes: new Uint8Array(rawBytes),
      resolvedUri,
      revision,
      ...(mime === undefined ? {} : { mime }),
      ...(integrity === undefined ? {} : { integrity })
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

  /** Returns detached byte slice for requested range. */
  async readRange(
    path: NormalizedMountPath,
    range: ByteRange,
    options: VFSReadOptions
  ): Promise<VFSProviderRangeReadResult> {
    validatePath(path);
    validateByteRange(range);
    if (options.signal?.aborted) {
      return Object.freeze({
        kind: 'aborted',
        code: 'vfs-read-aborted',
        message: 'VFS range read was aborted.',
        requestedUri: normalizeVFSUri(`asset://${path}`),
        providerId: this.id
      });
    }
    const entry = this.#entries.get(path);
    if (!entry) {
      return Object.freeze({
        kind: 'not-found',
        code: 'vfs-memory-not-found',
        message: 'Memory VFS entry was not found.',
        requestedUri: normalizeVFSUri(`asset://${path}`),
        providerId: this.id
      });
    }

    if (range.offset + range.length > entry.bytes.byteLength) {
      return Object.freeze({
        kind: 'range-not-satisfiable',
        code: 'vfs-range-out-of-bounds',
        message: `Requested range [${range.offset}, ${range.offset + range.length}) exceeds total length ${entry.bytes.byteLength}.`,
        requestedUri: entry.resolvedUri,
        providerId: this.id
      });
    }

    const sliced = sliceRangeBytes(entry.bytes, range);
    return Object.freeze({
      kind: 'success',
      bytes: sliced,
      range,
      totalLength: entry.bytes.byteLength,
      resolvedUri: entry.resolvedUri,
      revision: entry.revision,
      providerId: this.id,
      ...(entry.mime === undefined ? {} : { mime: entry.mime }),
      ...(entry.integrity === undefined ? {} : { integrity: entry.integrity })
    });
  }

  /** Opens single-consumer chunk stream over the in-memory entry. */
  async openStream(
    path: NormalizedMountPath,
    options: VFSStreamOptions
  ): Promise<VFSProviderStreamOpenResult> {
    validatePath(path);
    if (options.signal?.aborted) {
      return Object.freeze({
        kind: 'aborted',
        code: 'vfs-stream-aborted',
        message: 'VFS stream open was aborted.',
        requestedUri: normalizeVFSUri(`asset://${path}`),
        providerId: this.id
      });
    }
    const entry = this.#entries.get(path);
    if (!entry) {
      return Object.freeze({
        kind: 'not-found',
        code: 'vfs-memory-not-found',
        message: 'Memory VFS entry was not found.',
        requestedUri: normalizeVFSUri(`asset://${path}`),
        providerId: this.id
      });
    }

    const allBytes = entry.bytes.slice();
    const chunkSize = this.#streamChunkBytes;

    async function* chunkGenerator() {
      for (let offset = 0; offset < allBytes.byteLength; offset += chunkSize) {
        const end = Math.min(offset + chunkSize, allBytes.byteLength);
        yield {
          offset,
          bytes: allBytes.subarray(offset, end)
        };
      }
    }

    const session = createVFSStreamSession({
      metadata: Object.freeze({
        resolvedUri: entry.resolvedUri,
        providerId: this.id,
        revision: entry.revision,
        contentLength: allBytes.byteLength,
        ...(entry.mime === undefined ? {} : { mime: entry.mime })
      }),
      source: chunkGenerator(),
      expectedLength: allBytes.byteLength,
      ...(entry.integrity === undefined ? {} : { expectedIntegrity: entry.integrity })
    });

    return Object.freeze({
      kind: 'session',
      session
    });
  }
}

function validatePath(path: NormalizedMountPath): void {
  if (!path.startsWith('/') || path.includes('//') || path.includes('\\') || path.includes('\0')) {
    throw new Error('Memory VFS path must be normalized and rooted.');
  }
  toNormalizedMountPath(path === '/' ? [] : path.slice(1).split('/'));
}
