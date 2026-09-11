import { describe, expect, test } from 'vitest';
import {
  DEFAULT_VFS_READ_POLICY,
  MemoryVFSProvider,
  VirtualFileSystem,
  createVFSStreamSession,
  normalizeVFSUri,
  toNormalizedMountPath
} from '../../../src/assets/vfs';

const HASH_1_TO_7 = '32bbe378a25091502b2baf9f7258c19444e7a43ee4593b08030acd790bd66e6a';

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

  test('verifies stream completion with expectedIntegrity using incremental hash', async () => {
    const vfs = new VirtualFileSystem();
    const provider = new MemoryVFSProvider('memory-stream', {
      enableStream: true,
      streamChunkBytes: 3
    });
    const root = normalizeVFSUri('asset://test');
    const path = toNormalizedMountPath(['hashed.bin']);
    const fullBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);

    provider.put(path, {
      bytes: fullBytes,
      resolvedUri: normalizeVFSUri('asset://test/hashed.bin'),
      revision: 'v1'
    });

    vfs.mount({
      root,
      scheme: 'asset' as any,
      primary: provider,
      caches: [],
      policy: DEFAULT_VFS_READ_POLICY
    });

    const openResult = await vfs.openStream({
      uri: 'asset://test/hashed.bin',
      expectedIntegrity: `sha256:${HASH_1_TO_7}`
    });
    expect(openResult.kind).toBe('session');
    if (openResult.kind === 'session') {
      for await (const _chunk of openResult.session.chunks) {
        // Drain stream
      }
      const completion = await openResult.session.completion;
      expect(completion.kind).toBe('complete');
      if (completion.kind === 'complete') {
        expect(completion.verification.kind).toBe('content-hash');
        if (completion.verification.kind === 'content-hash') {
          expect(completion.verification.digest).toBe(HASH_1_TO_7);
        }
      }
    }
  });

  test('settles stream completion with integrity failure when expectedIntegrity mismatches', async () => {
    const vfs = new VirtualFileSystem();
    const provider = new MemoryVFSProvider('memory-stream', {
      enableStream: true,
      streamChunkBytes: 3
    });
    const root = normalizeVFSUri('asset://test');
    const path = toNormalizedMountPath(['mismatch.bin']);
    provider.put(path, {
      bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7]),
      resolvedUri: normalizeVFSUri('asset://test/mismatch.bin'),
      revision: 'v1'
    });

    vfs.mount({
      root,
      scheme: 'asset' as any,
      primary: provider,
      caches: [],
      policy: DEFAULT_VFS_READ_POLICY
    });

    const openResult = await vfs.openStream({
      uri: 'asset://test/mismatch.bin',
      expectedIntegrity: 'sha256:' + '0'.repeat(64)
    });
    expect(openResult.kind).toBe('session');
    if (openResult.kind === 'session') {
      for await (const _chunk of openResult.session.chunks) {
        // Drain stream
      }
      const completion = await openResult.session.completion;
      expect(completion.kind).toBe('integrity');
      if (completion.kind !== 'complete') {
        expect(completion.code).toBe('vfs-integrity-mismatch');
      }
    }
  });

  test('settles stream completion with integrity failure when expectedLength mismatches', async () => {
    const vfs = new VirtualFileSystem();
    const provider = new MemoryVFSProvider('memory-stream', {
      enableStream: true,
      streamChunkBytes: 3
    });
    const root = normalizeVFSUri('asset://test');
    const path = toNormalizedMountPath(['len.bin']);
    provider.put(path, {
      bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7]),
      resolvedUri: normalizeVFSUri('asset://test/len.bin'),
      revision: 'v1'
    });

    vfs.mount({
      root,
      scheme: 'asset' as any,
      primary: provider,
      caches: [],
      policy: DEFAULT_VFS_READ_POLICY
    });

    const openResult = await vfs.openStream({
      uri: 'asset://test/len.bin',
      expectedLength: 10
    });
    expect(openResult.kind).toBe('session');
    if (openResult.kind === 'session') {
      for await (const _chunk of openResult.session.chunks) {
        // Drain stream
      }
      const completion = await openResult.session.completion;
      expect(completion.kind).toBe('integrity');
      if (completion.kind !== 'complete') {
        expect(completion.code).toBe('vfs-integrity-mismatch');
      }
    }
  });

  test('rejects oversized chunks exceeding highWaterMarkBytes', async () => {
    async function* largeChunkGen() {
      yield new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    }

    const session = createVFSStreamSession({
      metadata: {
        resolvedUri: normalizeVFSUri('asset://test/hwm.bin'),
        providerId: 'test' as any,
        revision: '1',
        contentLength: 10
      },
      source: largeChunkGen(),
      highWaterMarkBytes: 4
    });

    const chunkLengths: number[] = [];
    for await (const chunk of session.chunks) {
      chunkLengths.push(chunk.bytes.byteLength);
    }

    expect(chunkLengths).toEqual([]);
    const completion = await session.completion;
    expect(completion.kind).toBe('provider-failure');
    if (completion.kind === 'provider-failure') {
      expect(completion.code).toBe('vfs-stream-chunk-overflow');
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

  test('rejects openStream with mismatched provenance and cancels session', async () => {
    const vfs = new VirtualFileSystem();
    const root = normalizeVFSUri('asset://test');
    let cancelCalled = false;

    vfs.mount({
      root,
      scheme: 'asset' as any,
      primary: {
        id: 'stream-prov' as any,
        capabilities: { read: true, stream: true, write: false, watch: false },
        read: async () => ({ kind: 'not-found', code: 'not-found', message: 'not found' }),
        openStream: async () => ({
          kind: 'session',
          session: {
            metadata: {
              resolvedUri: normalizeVFSUri('asset://test/spoofed.bin'),
              providerId: 'stream-prov' as any,
              revision: '1',
              contentLength: 3
            },
            chunks: (async function* () {
              yield { offset: 0, bytes: new Uint8Array([1, 2, 3]) };
            })(),
            completion: new Promise(() => {}),
            cancel: () => {
              cancelCalled = true;
            }
          }
        })
      },
      caches: [],
      policy: DEFAULT_VFS_READ_POLICY
    });

    const result = await vfs.openStream({ uri: 'asset://test/real.bin' });
    expect(result.kind).toBe('integrity');
    if (result.kind !== 'session') {
      expect(result.code).toBe('vfs-stream-provenance-mismatch');
    }
    expect(cancelCalled).toBe(true);
  });

  test('rejects invalid highWaterMarkBytes at public VFS boundary and session constructor', async () => {
    const vfs = new VirtualFileSystem();
    const provider = new MemoryVFSProvider('memory-stream', { enableStream: true });
    vfs.mount({
      root: normalizeVFSUri('asset://test'),
      scheme: 'asset' as any,
      primary: provider,
      caches: [],
      policy: DEFAULT_VFS_READ_POLICY
    });

    const invalidValues = [0, -1, 3.14, NaN, Infinity, -Infinity];
    for (const hwm of invalidValues) {
      const result = await vfs.openStream({
        uri: 'asset://test/file.bin',
        highWaterMarkBytes: hwm
      });
      expect(result.kind).toBe('invalid-request');
      if (result.kind === 'invalid-request') {
        expect(result.code).toBe('vfs-invalid-request');
      }

      expect(() =>
        createVFSStreamSession({
          metadata: {
            resolvedUri: normalizeVFSUri('asset://test/file.bin'),
            providerId: 'test' as any,
            revision: '1',
            contentLength: 1
          },
          source: (async function* () {})(),
          highWaterMarkBytes: hwm
        })
      ).toThrow(/highWaterMarkBytes must be a positive safe integer/i);
    }
  });
});
