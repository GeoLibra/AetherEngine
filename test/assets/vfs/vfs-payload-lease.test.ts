import { describe, expect, test } from 'vitest';
import {
  DEFAULT_VFS_READ_POLICY,
  VirtualFileSystem,
  normalizeVFSUri
} from '../../../src/assets/vfs';

describe('VFS platform payload leases', () => {
  test('returns unsupported-channel if provider lacks payload lease capability', async () => {
    const vfs = new VirtualFileSystem();
    const root = normalizeVFSUri('asset://test');
    vfs.mount({
      root,
      scheme: 'asset' as any,
      primary: {
        id: 'no-payload' as any,
        capabilities: { read: true, range: false, write: false, watch: false },
        read: async () => ({
          kind: 'not-found',
          code: 'not-found',
          message: 'not found'
        })
      },
      caches: [],
      policy: DEFAULT_VFS_READ_POLICY
    });

    const result = await vfs.acquirePayloadLease({ uri: 'asset://test/texture.png' });
    expect(result.kind).toBe('unsupported-channel');
  });

  test('acquires platform payload lease and enforces idempotent release', async () => {
    const vfs = new VirtualFileSystem();
    const root = normalizeVFSUri('asset://test');
    let releaseCalls = 0;

    vfs.mount({
      root,
      scheme: 'asset' as any,
      primary: {
        id: 'blob-provider' as any,
        capabilities: { read: true, payload: true, write: false, watch: false },
        read: async () => ({
          kind: 'not-found',
          code: 'not-found',
          message: 'not found'
        }),
        acquirePayloadLease: async () => {
          return {
            kind: 'lease',
            lease: {
              resolvedUri: normalizeVFSUri('asset://test/texture.png'),
              providerId: 'blob-provider' as any,
              revision: 'v1',
              verification: { kind: 'length-only', byteLength: 1024 },
              byteLength: 1024,
              payload: { fakeBlob: true },
              release: () => {
                releaseCalls++;
              }
            }
          };
        }
      },
      caches: [],
      policy: DEFAULT_VFS_READ_POLICY
    });

    const result = await vfs.acquirePayloadLease({ uri: 'asset://test/texture.png' });
    expect(result.kind).toBe('lease');
    if (result.kind === 'lease') {
      expect(result.lease.byteLength).toBe(1024);
      expect((result.lease.payload as any).fakeBlob).toBe(true);

      result.lease.release();
      result.lease.release();
      result.lease.release();
      expect(releaseCalls).toBe(1);
    }
  });

  test('enforces expectedLength and releases underlying lease on mismatch', async () => {
    const vfs = new VirtualFileSystem();
    const root = normalizeVFSUri('asset://test');
    let releaseCalls = 0;

    vfs.mount({
      root,
      scheme: 'asset' as any,
      primary: {
        id: 'blob-provider' as any,
        capabilities: { read: true, payload: true, write: false, watch: false },
        read: async () => ({
          kind: 'not-found',
          code: 'not-found',
          message: 'not found'
        }),
        acquirePayloadLease: async () => {
          return {
            kind: 'lease',
            lease: {
              resolvedUri: normalizeVFSUri('asset://test/texture.png'),
              providerId: 'blob-provider' as any,
              revision: 'v1',
              verification: { kind: 'length-only', byteLength: 1024 },
              byteLength: 1024,
              payload: { fakeBlob: true },
              release: () => {
                releaseCalls++;
              }
            }
          };
        }
      },
      caches: [],
      policy: DEFAULT_VFS_READ_POLICY
    });

    const result = await vfs.acquirePayloadLease({
      uri: 'asset://test/texture.png',
      expectedLength: 2048
    });
    expect(result.kind).toBe('integrity');
    if (result.kind !== 'lease') {
      expect(result.code).toBe('vfs-integrity-mismatch');
    }
    expect(releaseCalls).toBe(1);
  });

  test('validates payload lease provenance and releases lease on mismatch', async () => {
    const vfs = new VirtualFileSystem();
    const root = normalizeVFSUri('asset://test');
    let releaseCalls = 0;

    vfs.mount({
      root,
      scheme: 'asset' as any,
      primary: {
        id: 'real-provider' as any,
        capabilities: { read: true, payload: true, write: false, watch: false },
        read: async () => ({ kind: 'not-found', code: 'not-found', message: 'not found' }),
        acquirePayloadLease: async () => ({
          kind: 'lease',
          lease: {
            resolvedUri: normalizeVFSUri('asset://test/other-file.png'),
            providerId: 'real-provider' as any,
            revision: 'v1',
            verification: { kind: 'length-only', byteLength: 512 },
            byteLength: 512,
            payload: {},
            release: () => {
              releaseCalls++;
            }
          }
        })
      },
      caches: [],
      policy: DEFAULT_VFS_READ_POLICY
    });

    const result = await vfs.acquirePayloadLease({ uri: 'asset://test/texture.png' });
    expect(result.kind).toBe('integrity');
    if (result.kind !== 'lease') {
      expect(result.code).toBe('vfs-payload-provenance-mismatch');
    }
    expect(releaseCalls).toBe(1);
  });
});
