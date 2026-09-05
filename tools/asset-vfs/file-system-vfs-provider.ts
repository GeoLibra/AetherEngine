/** @file Node-only confined full-read provider for the asset VFS. */

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import {
  defineVFSProviderId,
  normalizeVFSUri,
  toNormalizedMountPath,
  type CanonicalVFSUri,
  type NormalizedMountPath,
  type VFSProvider,
  type VFSProviderCapabilities,
  type VFSProviderId,
  type VFSProviderReadFailure,
  type VFSProviderReadResult,
  type VFSReadOptions
} from '../../src/assets/vfs';
import type { FileSystemVFSProviderOptions } from './types';

const FILE_SYSTEM_CAPABILITIES: VFSProviderCapabilities = Object.freeze({
  read: true,
  range: false,
  write: false,
  watch: false
});

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  '.bin': 'application/octet-stream',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.json': 'application/json',
  '.ktx2': 'image/ktx2',
  '.png': 'image/png',
  '.wgsl': 'text/wgsl'
});

/** Reads regular files below one fixed native root without following internal symlinks. */
export class FileSystemVFSProvider implements VFSProvider {
  readonly id: VFSProviderId;
  readonly capabilities = FILE_SYSTEM_CAPABILITIES;
  readonly #rootDirectory: string;
  readonly #resolvedRootUri: CanonicalVFSUri;

  private constructor(id: VFSProviderId, rootDirectory: string, resolvedRootUri: CanonicalVFSUri) {
    this.id = id;
    this.#rootDirectory = rootDirectory;
    this.#resolvedRootUri = resolvedRootUri;
  }

  /** Resolves the configured root once and rejects invalid provider construction. */
  static async open(options: FileSystemVFSProviderOptions): Promise<FileSystemVFSProvider> {
    const idInput = options.id;
    const rootDirectoryInput = options.rootDirectory;
    const resolvedRootUriInput = options.resolvedRootUri;
    const id = defineVFSProviderId(idInput);
    const resolvedRootUri = normalizeVFSUri(resolvedRootUriInput);
    if (resolvedRootUri !== resolvedRootUriInput) {
      throw new Error('Filesystem VFS resolved root URI must be canonical.');
    }
    let rootDirectory: string;
    try {
      rootDirectory = await realpath(rootDirectoryInput);
      if (!(await stat(rootDirectory)).isDirectory()) {
        throw new Error('not-directory');
      }
    } catch {
      throw new Error('Filesystem VFS root is unavailable.');
    }
    return new FileSystemVFSProvider(id, rootDirectory, resolvedRootUri);
  }

  /** Returns detached bytes and provenance, or a typed redacted operational failure. */
  async read(path: NormalizedMountPath, options: VFSReadOptions): Promise<VFSProviderReadResult> {
    const segments = validatePath(path);
    if (options.signal?.aborted) return failure('aborted', 'vfs-read-aborted');
    try {
      const nativePath = join(this.#rootDirectory, ...segments);
      for (let index = 0; index < segments.length; index++) {
        const candidate = join(this.#rootDirectory, ...segments.slice(0, index + 1));
        if ((await lstat(candidate)).isSymbolicLink()) {
          return failure('permission', 'vfs-filesystem-symlink');
        }
      }
      const handle = await open(nativePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile()) return failure('provider-failure', 'vfs-filesystem-not-file');
        const bytes = new Uint8Array(await handle.readFile({ signal: options.signal }));
        const after = await handle.stat({ bigint: true });
        if (!sameFileVersion(before, after)) {
          return failure('provider-failure', 'vfs-filesystem-changed-during-read');
        }
        const integrity = createHash('sha256').update(bytes).digest('hex');
        const mime = MIME_BY_EXTENSION[extname(nativePath).toLowerCase()];
        return Object.freeze({
          kind: 'success',
          bytes,
          resolvedUri: resolvedUri(this.#resolvedRootUri, segments),
          revision: `fs:${before.dev}:${before.ino}:${before.size}:${before.mtimeNs}`,
          contentLength: bytes.byteLength,
          providerId: this.id,
          integrity,
          ...(mime === undefined ? {} : { mime })
        });
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (options.signal?.aborted || isFileSystemError(error, 'ABORT_ERR')) {
        return failure('aborted', 'vfs-read-aborted');
      }
      if (isFileSystemError(error, 'ENOENT') || isFileSystemError(error, 'ENOTDIR')) {
        return failure('not-found', 'vfs-filesystem-not-found');
      }
      if (
        isFileSystemError(error, 'EACCES') ||
        isFileSystemError(error, 'EPERM') ||
        isFileSystemError(error, 'ELOOP')
      ) {
        return failure('permission', 'vfs-filesystem-permission');
      }
      return failure('provider-failure', 'vfs-filesystem-failure');
    }
  }
}

function validatePath(path: NormalizedMountPath): readonly string[] {
  if (!path.startsWith('/') || path.includes('//') || path.includes('\\') || path.includes('\0')) {
    throw new Error('Filesystem VFS path must be normalized and rooted.');
  }
  const segments = path === '/' ? [] : path.slice(1).split('/');
  toNormalizedMountPath(segments);
  return segments;
}

function resolvedUri(root: CanonicalVFSUri, segments: readonly string[]): CanonicalVFSUri {
  if (segments.length === 0) return root;
  const separator = root.endsWith('//') ? '' : '/';
  return normalizeVFSUri(`${root}${separator}${segments.map(encodeURIComponent).join('/')}`);
}

function sameFileVersion(before: BigIntStats, after: BigIntStats): boolean {
  return (
    before.dev === after.dev &&
    before.ino === after.ino &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs
  );
}

function failure(kind: VFSProviderReadFailure['kind'], code: string): VFSProviderReadFailure {
  return Object.freeze({ kind, code, message: `Filesystem VFS read failed: ${kind}.` });
}

function isFileSystemError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
