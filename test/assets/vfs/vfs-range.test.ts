import { describe, expect, test } from 'vitest';
import {
  DEFAULT_VFS_READ_POLICY,
  MemoryVFSProvider,
  VirtualFileSystem,
  formatHttpRangeHeader,
  normalizeVFSUri,
  parseContentRangeHeader,
  sliceRangeBytes,
  toNormalizedMountPath
} from '../../../src/assets/vfs';

describe('VFS byte range operations and readRange contract', () => {
  test('formats HTTP Range header correctly', () => {
    expect(formatHttpRangeHeader({ offset: 0, length: 100 })).toBe('bytes=0-99');
    expect(formatHttpRangeHeader({ offset: 50, length: 50 })).toBe('bytes=50-99');
  });

  test('parses and validates Content-Range headers', () => {
    const parsed = parseContentRangeHeader('bytes 0-99/500', { offset: 0, length: 100 });
    expect(parsed.start).toBe(0);
    expect(parsed.endInclusive).toBe(99);
    expect(parsed.byteLength).toBe(100);
    expect(parsed.totalLength).toBe(500);

    // Wildcard total
    const wildcard = parseContentRangeHeader('bytes 10-19/*');
    expect(wildcard.totalLength).toBeNull();
    expect(wildcard.byteLength).toBe(10);

    // Mismatched expected range
    expect(() => parseContentRangeHeader('bytes 0-49/100', { offset: 0, length: 100 })).toThrow(
      /length mismatch/i
    );
  });

  test('slices detached byte range without retaining parent buffer', () => {
    const source = new Uint8Array([10, 20, 30, 40, 50]);
    const sliced = sliceRangeBytes(source, { offset: 1, length: 3 });
    expect(Array.from(sliced)).toEqual([20, 30, 40]);
    source[1] = 99;
    expect(sliced[0]).toBe(20);
  });

  test('returns unsupported-channel if provider does not support range reads', async () => {
    const vfs = new VirtualFileSystem();
    const provider = new MemoryVFSProvider('memory-plain'); // enableRange is false by default
    const root = normalizeVFSUri('asset://test');
    vfs.mount({
      root,
      scheme: 'asset' as any,
      primary: provider,
      caches: [],
      policy: DEFAULT_VFS_READ_POLICY
    });

    const result = await vfs.readRange({
      uri: 'asset://test/file.bin',
      range: { offset: 0, length: 10 }
    });

    expect(result.kind).toBe('unsupported-channel');
    if (result.kind === 'unsupported-channel') {
      expect(result.code).toBe('vfs-unsupported-channel');
    }
  });

  test('performs successful range read on supported provider', async () => {
    const vfs = new VirtualFileSystem();
    const provider = new MemoryVFSProvider('memory-range', { enableRange: true });
    const root = normalizeVFSUri('asset://test');
    const path = toNormalizedMountPath(['package.pkg']);
    const fullBytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    provider.put(path, {
      bytes: fullBytes,
      resolvedUri: normalizeVFSUri('asset://test/package.pkg'),
      revision: 'v1'
    });

    vfs.mount({
      root,
      scheme: 'asset' as any,
      primary: provider,
      caches: [],
      policy: DEFAULT_VFS_READ_POLICY
    });

    const result = await vfs.readRange({
      uri: 'asset://test/package.pkg',
      range: { offset: 2, length: 4 }
    });

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(Array.from(result.bytes)).toEqual([2, 3, 4, 5]);
      expect(result.range).toEqual({ offset: 2, length: 4 });
      expect(result.totalLength).toBe(10);
      expect(result.revision).toBe('v1');
    }
  });

  test('returns range-not-satisfiable for out of bounds ranges', async () => {
    const vfs = new VirtualFileSystem();
    const provider = new MemoryVFSProvider('memory-range', { enableRange: true });
    const root = normalizeVFSUri('asset://test');
    const path = toNormalizedMountPath(['package.pkg']);

    provider.put(path, {
      bytes: new Uint8Array([1, 2, 3]),
      resolvedUri: normalizeVFSUri('asset://test/package.pkg'),
      revision: 'v1'
    });

    vfs.mount({
      root,
      scheme: 'asset' as any,
      primary: provider,
      caches: [],
      policy: DEFAULT_VFS_READ_POLICY
    });

    const result = await vfs.readRange({
      uri: 'asset://test/package.pkg',
      range: { offset: 2, length: 10 }
    });

    expect(result.kind).toBe('range-not-satisfiable');
  });
});
