import { describe, expect, test } from 'vitest';
import {
  normalizeVFSUri,
  parseCanonicalVFSUri,
  toNormalizedMountPath
} from '../../../src/assets/vfs';

describe('VFS URI normalization', () => {
  test('canonicalizes the scheme and encodes decoded path segments', () => {
    expect(normalizeVFSUri('ASSET://textures/brick.ktx2')).toBe('asset://textures/brick.ktx2');
    expect(normalizeVFSUri('asset://textures/my%20brick.png')).toBe(
      'asset://textures/my%20brick.png'
    );
    expect(normalizeVFSUri('asset://')).toBe('asset://');
  });

  test.each([
    '',
    'textures/a.png',
    'asset:///a.png',
    'asset://a//b',
    'asset://a/./b',
    'asset://a/../b',
    'asset://a/%2e%2e/b',
    'asset://a/%2F/b',
    'asset://a/%5c/b',
    'asset://a\\b',
    'asset://a/%00/b',
    'asset://a/%ZZ/b',
    'asset://a?revision=1',
    'asset://a#fragment'
  ])('rejects unsafe or non-canonical input %s', (input) => {
    expect(() => normalizeVFSUri(input)).toThrow('Invalid VFS URI');
  });

  test('parses immutable decoded segments without applying OS path semantics', () => {
    const parsed = parseCanonicalVFSUri(normalizeVFSUri('asset://textures/my%20brick.png'));

    expect(parsed).toEqual({ scheme: 'asset', segments: ['textures', 'my brick.png'] });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.segments)).toBe(true);
    expect(toNormalizedMountPath([])).toBe('/');
    expect(toNormalizedMountPath(['ui', 'button.png'])).toBe('/ui/button.png');
  });
});
