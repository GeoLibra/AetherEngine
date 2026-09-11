import { describe, expect, test } from 'vitest';
import {
  DEFAULT_VFS_READ_POLICY,
  MemoryVFSProvider,
  VirtualFileSystem,
  createVFSStreamSession,
  normalizeVFSUri,
  toNormalizedMountPath
} from '../../../src/assets/vfs';

describe('VFS stream channel and session lifecycle', () => {
  test('returns unsupported-channel if provider does not support stream sessions', async () => {
    const vfs = new VirtualFileSystem();
    const provider = new MemoryVFSProvider('memory-plain'); // stream: false
    const root = normalizeVFSUri('asset://test');
    vfs.mount({
      root,
      scheme: 'asset' as any,
      primary: provider,
      caches: [],
      policy: DEFAULT_VFS_READ_POLICY
    });

    const result = await vfs.openStream({ uri: 'asset://test/file.bin' });
    expect(result.kind).toBe('unsupported-channel');
  });

  test('iterates chunks and passively verifies terminal completion', async () => {
    const vfs = new VirtualFileSystem();
    const provider = new MemoryVFSProvider('memory-stream', {
      enableStream: true,
      streamChunkBytes: 3
    });
    const root = normalizeVFSUri('asset://test');
    const path = toNormalizedMountPath(['stream.bin']);
    const fullBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);

    provider.put(path, {
      bytes: fullBytes,
      resolvedUri: normalizeVFSUri('asset://test/stream.bin'),
      revision: 'v1'
    });

    vfs.mount({
      root,
      scheme: 'asset' as any,
      primary: provider,
      caches: [],
      policy: DEFAULT_VFS_READ_POLICY
    });

    const openResult = await vfs.openStream({ uri: 'asset://test/stream.bin' });
    expect(openResult.kind).toBe('session');

    if (openResult.kind === 'session') {
      const session = openResult.session;
      expect(session.metadata.contentLength).toBe(7);

      const collected: number[] = [];
      const offsets: number[] = [];

      for await (const chunk of session.chunks) {
        offsets.push(chunk.offset);
        collected.push(...chunk.bytes);
      }

      expect(collected).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(offsets).toEqual([0, 3, 6]);

      const completion = await session.completion;
      expect(completion.kind).toBe('complete');
      if (completion.kind === 'complete') {
        expect(completion.revision).toBe('v1');
        expect(completion.verification.kind).toBe('length-only');
        expect(completion.verification.byteLength).toBe(7);
      }
    }
  });

  test('strictly enforces single-consumer iterator rule', async () => {
    async function* simpleGen() {
      yield new Uint8Array([1, 2]);
    }

    const session = createVFSStreamSession({
      metadata: {
        resolvedUri: normalizeVFSUri('asset://test/single.bin'),
        providerId: 'test' as any,
        revision: '1',
        contentLength: 2
      },
      source: simpleGen()
    });

    // First iterator succeeds
    const it1 = session.chunks[Symbol.asyncIterator]();
    expect(it1).toBeDefined();

    // Second iterator call throws contract error
    expect(() => session.chunks[Symbol.asyncIterator]()).toThrow(/single-consumer/i);
  });

  test('early iterator exit cancels session and settles completion as aborted', async () => {
    async function* infiniteGen() {
      let count = 0;
      while (true) {
        yield new Uint8Array([count++]);
      }
    }

    let onCancelCalled = false;
    const session = createVFSStreamSession({
      metadata: {
        resolvedUri: normalizeVFSUri('asset://test/infinite.bin'),
        providerId: 'test' as any,
        revision: '1',
        contentLength: null
      },
      source: infiniteGen(),
      onCancel: () => {
        onCancelCalled = true;
      }
    });

    for await (const chunk of session.chunks) {
      if (chunk.offset === 0) {
        break; // Early exit triggers iterator return()
      }
    }

    expect(onCancelCalled).toBe(true);
    const completion = await session.completion;
    expect(completion.kind).toBe('aborted');
  });

  test('explicit session.cancel() is idempotent and settles completion', async () => {
    async function* simpleGen() {
      yield new Uint8Array([1, 2, 3]);
    }

    const session = createVFSStreamSession({
      metadata: {
        resolvedUri: normalizeVFSUri('asset://test/cancel.bin'),
        providerId: 'test' as any,
        revision: '1',
        contentLength: 3
      },
      source: simpleGen()
    });

    session.cancel();
    session.cancel(); // Idempotent

    const completion = await session.completion;
    expect(completion.kind).toBe('aborted');
  });
});
