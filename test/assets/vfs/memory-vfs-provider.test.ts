import { describe, expect, test } from 'vitest';
import {
  MemoryVFSProvider,
  normalizeVFSUri,
  toNormalizedMountPath,
  type NormalizedMountPath,
  type CanonicalVFSUri,
  type MemoryVFSProviderEntry
} from '../../../src/assets/vfs';

const UTF8 = new TextEncoder();

describe('MemoryVFSProvider', () => {
  test('owns native Buffer input instead of retaining its slice view', async () => {
    const provider = new MemoryVFSProvider('memory');
    const bytes = Buffer.from([1, 2, 3]);
    const path = toNormalizedMountPath(['item']);
    provider.put(path, { bytes, resolvedUri: normalizeVFSUri('asset://item'), revision: '1' });
    bytes[0] = 99;
    const result = await provider.read(path, {});
    expect(result.kind === 'success' && result.bytes[0]).toBe(1);
  });
  test.each(['/..', '/a/./b', '/a/', '/a//b', 'relative'])(
    'rejects unsafe retained path %s',
    async (value) => {
      const provider = new MemoryVFSProvider('memory');
      const path = value as NormalizedMountPath;
      expect(() =>
        provider.put(path, {
          bytes: new Uint8Array(),
          resolvedUri: normalizeVFSUri('asset://item'),
          revision: '1'
        })
      ).toThrow();
      expect(() => provider.delete(path)).toThrow();
      await expect(provider.read(path, {})).rejects.toThrow();
    }
  );

  test('rejects noncanonical resolved identities before retaining entries', () => {
    const provider = new MemoryVFSProvider('memory');
    expect(() =>
      provider.put(toNormalizedMountPath(['item']), {
        bytes: new Uint8Array(),
        resolvedUri: 'ASSET://item' as CanonicalVFSUri,
        revision: '1'
      })
    ).toThrow('canonical');
  });
  test('copies inserted and returned bytes while preserving metadata', async () => {
    const provider = new MemoryVFSProvider('memory');
    const input = UTF8.encode('hello');
    const path = toNormalizedMountPath(['hello.txt']);
    provider.put(path, {
      bytes: input,
      resolvedUri: normalizeVFSUri('asset://hello.txt'),
      revision: 'revision-1',
      mime: 'text/plain'
    });
    input[0] = 0;

    const first = await provider.read(path, {});
    expect(first).toMatchObject({
      kind: 'success',
      revision: 'revision-1',
      mime: 'text/plain',
      contentLength: 5,
      providerId: 'memory'
    });
    if (first.kind !== 'success') throw new Error('Expected memory read success.');
    first.bytes[0] = 0;
    const second = await provider.read(path, {});
    expect(second.kind === 'success' && new TextDecoder().decode(second.bytes)).toBe('hello');
  });

  test('returns typed missing and pre-aborted outcomes', async () => {
    const provider = new MemoryVFSProvider('memory');
    const path = toNormalizedMountPath(['missing.bin']);
    expect(await provider.read(path, {})).toMatchObject({
      kind: 'not-found',
      code: 'vfs-memory-not-found'
    });
    const controller = new AbortController();
    controller.abort();
    expect(await provider.read(path, { signal: controller.signal })).toMatchObject({
      kind: 'aborted',
      code: 'vfs-read-aborted'
    });
  });

  test('deletes entries and validates retained identities', async () => {
    expect(() => new MemoryVFSProvider('')).toThrow('non-empty');
    const provider = new MemoryVFSProvider('memory');
    const path = toNormalizedMountPath(['item.bin']);
    expect(() =>
      provider.put(path, {
        bytes: new Uint8Array(),
        resolvedUri: normalizeVFSUri('asset://item.bin'),
        revision: ''
      })
    ).toThrow('revision');
    provider.put(path, {
      bytes: new Uint8Array([1]),
      resolvedUri: normalizeVFSUri('asset://item.bin'),
      revision: '1'
    });
    expect(provider.delete(path)).toBe(true);
    expect((await provider.read(path, {})).kind).toBe('not-found');
  });

  test('retains prototype getters on entry class instances', async () => {
    const provider = new MemoryVFSProvider('memory');
    const path = toNormalizedMountPath(['getter-item.txt']);

    class GetterEntry implements MemoryVFSProviderEntry {
      readonly bytes = UTF8.encode('hello');
      get resolvedUri(): CanonicalVFSUri {
        return normalizeVFSUri('asset://getter-item.txt');
      }
      get revision(): string {
        return 'rev-getter';
      }
      get mime(): string {
        return 'text/plain';
      }
      get integrity(): string {
        return '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
      }
    }

    provider.put(path, new GetterEntry());
    const result = await provider.read(path, {});
    expect(result).toMatchObject({
      kind: 'success',
      resolvedUri: 'asset://getter-item.txt',
      revision: 'rev-getter',
      mime: 'text/plain',
      integrity: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      contentLength: 5,
      providerId: 'memory'
    });
  });

  test('reads entry getters exactly once during insertion and retains stateful fields', async () => {
    const provider = new MemoryVFSProvider('memory');
    const path = toNormalizedMountPath(['single-read.txt']);
    let mimeCalls = 0;
    let integrityCalls = 0;
    let revisionCalls = 0;
    let uriCalls = 0;
    let bytesCalls = 0;

    const entry = {
      get bytes(): Uint8Array {
        bytesCalls++;
        return UTF8.encode('hello');
      },
      get resolvedUri(): CanonicalVFSUri {
        uriCalls++;
        return normalizeVFSUri('asset://single-read.txt');
      },
      get revision(): string {
        revisionCalls++;
        return 'rev-single';
      },
      get mime(): string | undefined {
        mimeCalls++;
        return mimeCalls === 1 ? 'text/plain' : undefined;
      },
      get integrity(): string | undefined {
        integrityCalls++;
        return integrityCalls === 1
          ? '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
          : undefined;
      }
    };

    provider.put(path, entry as unknown as MemoryVFSProviderEntry);
    expect(bytesCalls).toBe(1);
    expect(uriCalls).toBe(1);
    expect(revisionCalls).toBe(1);
    expect(mimeCalls).toBe(1);
    expect(integrityCalls).toBe(1);

    const result = await provider.read(path, {});
    expect(result).toMatchObject({
      kind: 'success',
      resolvedUri: 'asset://single-read.txt',
      revision: 'rev-single',
      mime: 'text/plain',
      integrity: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      contentLength: 5,
      providerId: 'memory'
    });
  });
});
