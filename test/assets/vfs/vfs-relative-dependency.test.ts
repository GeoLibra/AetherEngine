import { describe, expect, test } from 'vitest';
import {
  normalizeVFSUri,
  redactTransportMetadata,
  resolveVFSRelativeUri
} from '../../../src/assets/vfs';

describe('VFS relative dependency resolution and transport redaction', () => {
  const baseDocument = normalizeVFSUri('asset://models/vehicles/car/body.gltf');

  test('resolves sibling asset path within the same directory', () => {
    const resolved = resolveVFSRelativeUri(baseDocument, 'wheel.bin');
    expect(resolved).toBe('asset://models/vehicles/car/wheel.bin');
  });

  test('resolves relative parent directory paths', () => {
    const resolved = resolveVFSRelativeUri(baseDocument, '../textures/paint.png');
    expect(resolved).toBe('asset://models/vehicles/textures/paint.png');
  });

  test('removes current directory dot segments', () => {
    const resolved = resolveVFSRelativeUri(baseDocument, './interior/./seat.gltf');
    expect(resolved).toBe('asset://models/vehicles/car/interior/seat.gltf');
  });

  test('strips format fragments without affecting resolution', () => {
    const resolved = resolveVFSRelativeUri(baseDocument, 'wheel.bin#node3');
    expect(resolved).toBe('asset://models/vehicles/car/wheel.bin');
  });

  test('strictly rejects escaping above the scheme root', () => {
    expect(() => resolveVFSRelativeUri(baseDocument, '../../../../escape.glb')).toThrow(
      /escaped root/i
    );
  });

  test('strictly rejects backslashes in relative paths', () => {
    expect(() => resolveVFSRelativeUri(baseDocument, '..\\textures\\paint.png')).toThrow(
      /backslashes/i
    );
  });

  test('strictly rejects NUL characters in relative paths', () => {
    expect(() => resolveVFSRelativeUri(baseDocument, 'texture\0.png')).toThrow(/NUL/i);
  });

  test('strictly rejects percent-encoded separators and NUL bytes', () => {
    expect(() => resolveVFSRelativeUri(baseDocument, '..%2Ftextures%2Fpaint.png')).toThrow(
      /percent-encoded/i
    );
    expect(() => resolveVFSRelativeUri(baseDocument, '..%5Ctextures%5Cpaint.png')).toThrow(
      /percent-encoded/i
    );
    expect(() => resolveVFSRelativeUri(baseDocument, 'secret%00.txt')).toThrow(/percent-encoded/i);
  });

  test('strictly rejects repeated-encoding traversal attacks', () => {
    expect(() => resolveVFSRelativeUri(baseDocument, '%252e%252e/escape')).toThrow(
      /repeated percent-encoding/i
    );
  });

  test('cross-mount absolute dependency requires allowCrossMount option', () => {
    const target = 'remote://cdn.example.com/shared/texture.ktx2';
    expect(() => resolveVFSRelativeUri(baseDocument, target)).toThrow(/cross-mount/i);

    const allowed = resolveVFSRelativeUri(baseDocument, target, { allowCrossMount: true });
    expect(allowed).toBe('remote://cdn.example.com/shared/texture.ktx2');
  });

  test('redacts sensitive headers, query parameters, and local file paths', () => {
    const redacted = redactTransportMetadata({
      url: 'https://cdn.example.com/models/car.glb?token=secret123&version=2&sig=abc',
      headers: {
        Authorization: 'Bearer secret-jwt-token',
        'X-API-Key': 'key-12345',
        Accept: 'application/octet-stream'
      },
      details: {
        localPath: '/Users/developer/project/secret.key',
        fileSize: 1024
      }
    });

    expect(redacted.url).toBe(
      'https://cdn.example.com/models/car.glb?token=%5BREDACTED%5D&version=2&sig=%5BREDACTED%5D'
    );
    expect(redacted.headers).toEqual({
      Authorization: '[REDACTED]',
      'X-API-Key': '[REDACTED]',
      Accept: 'application/octet-stream'
    });
    expect(redacted.details?.localPath).toBe('[REDACTED_PATH]');
    expect(redacted.details?.fileSize).toBe(1024);
  });
});
