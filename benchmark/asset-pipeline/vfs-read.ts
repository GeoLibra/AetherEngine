import {
  DEFAULT_VFS_READ_POLICY,
  MemoryVFSProvider,
  VirtualFileSystem,
  createVFSStreamSession,
  normalizeVFSUri,
  parseCanonicalVFSUri,
  sliceRangeBytes,
  toNormalizedMountPath
} from '../../src/assets/vfs';
import type { ByteRange } from '../../src/assets/vfs';

/** Deterministic full-read fixture with competing mount roots and owned bytes. */
export function createVFSReadFixture(mountCount: number, byteLength: number) {
  const bytes = Uint8Array.from({ length: byteLength }, (_, index) => index % 251);
  const vfs = new VirtualFileSystem();
  let dispatches = 0;
  for (let index = 0; index < mountCount; index++) {
    const root = normalizeVFSUri(`asset://mount-${index}`);
    const provider = new MemoryVFSProvider(`memory-${index}`);
    provider.put(toNormalizedMountPath(['payload']), {
      bytes,
      resolvedUri: normalizeVFSUri(`${root}/payload`),
      revision: '1'
    });
    vfs.mount({
      root,
      scheme: parseCanonicalVFSUri(root).scheme,
      caches: [],
      primary: {
        id: provider.id,
        capabilities: provider.capabilities,
        read(path, options) {
          dispatches++;
          return provider.read(path, options);
        }
      },
      policy: DEFAULT_VFS_READ_POLICY
    });
  }
  const uri = normalizeVFSUri(`asset://mount-${mountCount - 1}/payload`);
  return { bytes, vfs, uri, providerId: `memory-${mountCount - 1}`, dispatches: () => dispatches };
}

/** Deterministic range read fixture with representation pinning. */
export function createVFSRangeFixture(packageByteLength: number, chunkSize: number) {
  const bytes = Uint8Array.from({ length: packageByteLength }, (_, index) => (index * 7) % 256);
  const vfs = new VirtualFileSystem();
  const root = normalizeVFSUri('asset://packages');
  const provider = new MemoryVFSProvider('memory-pkg', { enableRange: true });
  const path = toNormalizedMountPath(['archive.pkg']);

  provider.put(path, {
    bytes,
    resolvedUri: normalizeVFSUri(`${root}/archive.pkg`),
    revision: 'v1'
  });

  vfs.mount({
    root,
    scheme: 'asset' as any,
    primary: provider,
    caches: [],
    policy: DEFAULT_VFS_READ_POLICY
  });

  const uri = normalizeVFSUri(`${root}/archive.pkg`);
  const range: ByteRange = Object.freeze({ offset: 0, length: chunkSize });

  return { bytes, vfs, uri, range, revision: 'v1' };
}

/** Raw range slice comparator retaining detached byte ownership. */
export function sliceVFSRangeReference(bytes: Uint8Array, range: ByteRange): Uint8Array {
  return sliceRangeBytes(bytes, range);
}

/** Deterministic bounded stream fixture with pull iteration. */
export function createVFSStreamFixture(totalBytes: number, chunkSize: number) {
  const bytes = Uint8Array.from({ length: totalBytes }, (_, index) => (index * 13) % 256);
  const vfs = new VirtualFileSystem();
  const root = normalizeVFSUri('asset://streams');
  const provider = new MemoryVFSProvider('memory-stream', {
    enableStream: true,
    streamChunkBytes: chunkSize
  });
  const path = toNormalizedMountPath(['stream.bin']);

  provider.put(path, {
    bytes,
    resolvedUri: normalizeVFSUri(`${root}/stream.bin`),
    revision: 'v1'
  });

  vfs.mount({
    root,
    scheme: 'asset' as any,
    primary: provider,
    caches: [],
    policy: DEFAULT_VFS_READ_POLICY
  });

  const uri = normalizeVFSUri(`${root}/stream.bin`);
  return { bytes, vfs, uri, totalBytes, chunkSize };
}

/** Raw copy comparator retains the same detached byte ownership contract. */
export function copyVFSReadReference(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(bytes);
}

/** Full-byte checksum oracle independent of mount routing. */
export function vfsByteChecksum(bytes: Uint8Array): number {
  let checksum = 0;
  for (const byte of bytes) checksum = (checksum + byte) >>> 0;
  return checksum;
}
