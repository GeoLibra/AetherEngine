import {
  DEFAULT_VFS_READ_POLICY,
  MemoryVFSProvider,
  VirtualFileSystem,
  normalizeVFSUri,
  parseCanonicalVFSUri,
  toNormalizedMountPath
} from '../../src/assets/vfs';

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
