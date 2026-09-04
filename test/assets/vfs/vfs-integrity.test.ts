import { describe, expect, test } from 'vitest';
import {
  normalizeVFSUri,
  validateExpectedIntegrity,
  validateVFSReadSuccess
} from '../../../src/assets/vfs';
import type { VFSProviderId, VFSReadSuccess } from '../../../src/assets/vfs';

const HELLO_SHA256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
const UTF8 = new TextEncoder();

describe('VFS integrity validation', () => {
  test('snapshots metadata before asynchronous hashing and omits private fields', async () => {
    const mutable = { ...success(UTF8.encode('hello'), 5, HELLO_SHA256), privatePath: '/secret' };
    const pending = validateVFSReadSuccess(
      normalizeVFSUri('asset://hello.txt'),
      { uri: 'asset://hello.txt' },
      mutable
    );
    mutable.revision = 'changed';
    mutable.contentLength = 99;
    const result = await pending;
    expect(result).toMatchObject({ kind: 'success', revision: 'revision-1', contentLength: 5 });
    expect(result).not.toHaveProperty('privatePath');
  });
  test('accepts canonical and prefixed SHA-256 expectations', () => {
    expect(validateExpectedIntegrity(HELLO_SHA256)).toBe(HELLO_SHA256);
    expect(validateExpectedIntegrity(`sha256:${HELLO_SHA256}`)).toBe(HELLO_SHA256);
    expect(() => validateExpectedIntegrity('sha1:abc')).toThrow('SHA-256');
  });

  test('publishes an owned byte copy after length and digest validation', async () => {
    const source = UTF8.encode('hello');
    const result = await validateVFSReadSuccess(
      normalizeVFSUri('asset://hello.txt'),
      { uri: 'asset://hello.txt', expectedLength: 5, expectedIntegrity: HELLO_SHA256 },
      success(source, 5, HELLO_SHA256)
    );
    expect(result.kind).toBe('success');
    if (result.kind !== 'success') throw new Error('Expected successful validation.');
    source[0] = 0;
    expect(new TextDecoder().decode(result.bytes)).toBe('hello');
  });

  test.each([
    ['provider length', { expectedLength: 5 }, success(UTF8.encode('hello'), 4)],
    ['expected length', { expectedLength: 4 }, success(UTF8.encode('hello'), 5)],
    ['expected digest', { expectedIntegrity: '0'.repeat(64) }, success(UTF8.encode('hello'), 5)],
    ['provider digest', {}, success(UTF8.encode('hello'), 5, '0'.repeat(64))]
  ])('rejects a %s mismatch', async (_label, request, providerResult) => {
    const result = await validateVFSReadSuccess(
      normalizeVFSUri('asset://hello.txt'),
      { uri: 'asset://hello.txt', ...request },
      providerResult
    );
    expect(result).toMatchObject({ kind: 'integrity', code: 'vfs-integrity-mismatch' });
  });
});

function success(bytes: Uint8Array, contentLength: number, integrity?: string): VFSReadSuccess {
  return {
    kind: 'success',
    bytes,
    resolvedUri: normalizeVFSUri('asset://hello.txt'),
    revision: 'revision-1',
    contentLength,
    providerId: 'memory' as VFSProviderId,
    ...(integrity === undefined ? {} : { integrity })
  };
}
