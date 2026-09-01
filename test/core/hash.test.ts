import { describe, expect, test } from 'vitest';
import { canonicalStringify, fnv1a32, fnv1a32Hex, fnv1a64, stableHash } from '../../src/core/hash';

describe('core/hash', () => {
  describe('canonicalStringify', () => {
    test('handles primitives, null, and undefined', () => {
      expect(canonicalStringify('hello')).toBe('"hello"');
      expect(canonicalStringify(123)).toBe('123');
      expect(canonicalStringify(true)).toBe('true');
      expect(canonicalStringify(null)).toBe('null');
      expect(canonicalStringify(undefined)).toBe(undefined);
    });

    test('sorts object keys lexicographically at all levels', () => {
      const obj1 = { z: 1, a: 2, m: { y: 'nested', b: 'nested' } };
      const obj2 = { a: 2, m: { b: 'nested', y: 'nested' }, z: 1 };

      const serialized1 = canonicalStringify(obj1);
      const serialized2 = canonicalStringify(obj2);

      expect(serialized1).toBe(serialized2);
      expect(serialized1).toBe('{"a":2,"m":{"b":"nested","y":"nested"},"z":1}');
    });

    test('preserves array element order', () => {
      const arr1 = [1, 2, 3];
      const arr2 = [3, 2, 1];

      expect(canonicalStringify(arr1)).toBe('[1,2,3]');
      expect(canonicalStringify(arr2)).toBe('[3,2,1]');
      expect(canonicalStringify(arr1)).not.toBe(canonicalStringify(arr2));
    });
  });

  describe('fnv1a64', () => {
    test('returns 16-character hexadecimal string', () => {
      const hash = fnv1a64('test-string');
      expect(hash).toMatch(/^[0-9a-f]{16}$/);
    });

    test('is deterministic across identical inputs', () => {
      const hash1 = fnv1a64('deterministic-test');
      const hash2 = fnv1a64('deterministic-test');
      expect(hash1).toBe(hash2);
    });

    test('produces different hashes for different inputs', () => {
      const hash1 = fnv1a64('input-a');
      const hash2 = fnv1a64('input-b');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('fnv1a32 and fnv1a32Hex', () => {
    test('fnv1a32 returns unsigned 32-bit integer', () => {
      const hash = fnv1a32('pipeline-key-example');
      expect(typeof hash).toBe('number');
      expect(Number.isInteger(hash)).toBe(true);
      expect(hash).toBeGreaterThanOrEqual(0);
      expect(hash).toBeLessThanOrEqual(0xffffffff);
    });

    test('fnv1a32Hex returns 8-character hexadecimal string', () => {
      const text = 'pipeline-key-example';
      const hashNum = fnv1a32(text);
      const hashHex = fnv1a32Hex(text);

      expect(hashHex).toMatch(/^[0-9a-f]{8}$/);
      expect(hashHex).toBe(hashNum.toString(16).padStart(8, '0'));
    });

    test('is deterministic', () => {
      expect(fnv1a32Hex('hello')).toBe(fnv1a32Hex('hello'));
      expect(fnv1a32Hex('hello')).not.toBe(fnv1a32Hex('world'));
    });
  });

  describe('stableHash', () => {
    test('hashes raw strings directly with fnv1a64', () => {
      const str = 'direct-string';
      expect(stableHash(str)).toBe(fnv1a64(str));
    });

    test('is invariant to object property insertion order', () => {
      const objA = { name: 'pipeline', layout: 'std140', count: 4 };
      const objB = { count: 4, name: 'pipeline', layout: 'std140' };

      expect(stableHash(objA)).toBe(stableHash(objB));
    });

    test('hashes nested objects and arrays deterministically', () => {
      const complex1 = {
        meta: { version: 1, target: 'webgpu' },
        entries: [
          { binding: 0, type: 'uniform' },
          { binding: 1, type: 'texture' }
        ]
      };
      const complex2 = {
        entries: [
          { binding: 0, type: 'uniform' },
          { binding: 1, type: 'texture' }
        ],
        meta: { target: 'webgpu', version: 1 }
      };

      expect(stableHash(complex1)).toBe(stableHash(complex2));
    });
  });
});
