import { describe, expect, test } from 'vitest';
import {
  DEFAULT_VFS_READ_POLICY,
  MemoryVFSProvider,
  VirtualFileSystem,
  normalizeVFSUri,
  toNormalizedMountPath
} from '../../../src/assets/vfs';

describe('VFS in-flight coalescing and independent cancellation leases', () => {
  test('coalesces concurrent reads for the same transport key into one provider read', async () => {
    const vfs = new VirtualFileSystem();
    let providerCalls = 0;

    const root = normalizeVFSUri('asset://test');
    vfs.mount({
      root,
      scheme: 'asset' as any,
      primary: {
        id: 'slow-provider' as any,
        capabilities: { read: true, range: false, write: false, watch: false },
        async read() {
          providerCalls++;
          await new Promise((resolve) => setTimeout(resolve, 50));
          return {
            kind: 'success',
            bytes: new Uint8Array([10, 20, 30]),
            resolvedUri: normalizeVFSUri('asset://test/data.bin'),
            revision: '1',
            contentLength: 3,
            providerId: 'slow-provider' as any
          };
        }
      },
      caches: [],
      policy: DEFAULT_VFS_READ_POLICY
    });

    const read1 = vfs.read({ uri: 'asset://test/data.bin' });
    const read2 = vfs.read({ uri: 'asset://test/data.bin' });
    const read3 = vfs.read({ uri: 'asset://test/data.bin' });

    const [res1, res2, res3] = await Promise.all([read1, read2, read3]);

    expect(providerCalls).toBe(1);
    expect(res1.kind).toBe('success');
    expect(res2.kind).toBe('success');
    expect(res3.kind).toBe('success');

    // Verify detached byte buffers between consumers
    if (res1.kind === 'success' && res2.kind === 'success') {
      expect(res1.bytes).not.toBe(res2.bytes);
      res1.bytes[0] = 99;
      expect(res2.bytes[0]).toBe(10);
    }
  });

  test('cancelling one consumer lease does not abort the in-flight read for other consumers', async () => {
    const vfs = new VirtualFileSystem();
    let providerAborted = false;

    const root = normalizeVFSUri('asset://test');
    vfs.mount({
      root,
      scheme: 'asset' as any,
      primary: {
        id: 'cancellable-provider' as any,
        capabilities: { read: true, range: false, write: false, watch: false },
        async read(path, options) {
          return new Promise((resolve) => {
            options.signal?.addEventListener('abort', () => {
              providerAborted = true;
              resolve({
                kind: 'aborted',
                code: 'vfs-aborted',
                message: 'Provider aborted.'
              });
            });
            setTimeout(() => {
              resolve({
                kind: 'success',
                bytes: new Uint8Array([1, 2, 3]),
                resolvedUri: normalizeVFSUri('asset://test/data.bin'),
                revision: '1',
                contentLength: 3,
                providerId: 'cancellable-provider' as any
              });
            }, 60);
          });
        }
      },
      caches: [],
      policy: DEFAULT_VFS_READ_POLICY
    });

    const controller1 = new AbortController();
    const controller2 = new AbortController();

    const read1 = vfs.read({ uri: 'asset://test/data.bin', signal: controller1.signal });
    const read2 = vfs.read({ uri: 'asset://test/data.bin', signal: controller2.signal });

    // Cancel consumer 1 early
    setTimeout(() => {
      controller1.abort();
    }, 20);

    const [res1, res2] = await Promise.all([read1, read2]);

    expect(res1.kind).toBe('aborted');
    expect(res2.kind).toBe('success');
    expect(providerAborted).toBe(false);
  });

  test('aborts the underlying transport when ALL consumer leases are cancelled', async () => {
    const vfs = new VirtualFileSystem();
    let providerAborted = false;

    const root = normalizeVFSUri('asset://test');
    vfs.mount({
      root,
      scheme: 'asset' as any,
      primary: {
        id: 'cancellable-provider' as any,
        capabilities: { read: true, range: false, write: false, watch: false },
        async read(path, options) {
          return new Promise((resolve) => {
            options.signal?.addEventListener('abort', () => {
              providerAborted = true;
              resolve({
                kind: 'aborted',
                code: 'vfs-aborted',
                message: 'Provider aborted.'
              });
            });
          });
        }
      },
      caches: [],
      policy: DEFAULT_VFS_READ_POLICY
    });

    const controller1 = new AbortController();
    const controller2 = new AbortController();

    const read1 = vfs.read({ uri: 'asset://test/data.bin', signal: controller1.signal });
    const read2 = vfs.read({ uri: 'asset://test/data.bin', signal: controller2.signal });

    controller1.abort();
    controller2.abort();

    const [res1, res2] = await Promise.all([read1, read2]);

    expect(res1.kind).toBe('aborted');
    expect(res2.kind).toBe('aborted');
    expect(providerAborted).toBe(true);
  });
});
