import { describe, expect, test } from 'vitest';
import { isPlainRecord, isPromiseLike, isRecord } from '../../src/core/utils/guards';

describe('core/guards', () => {
  describe('isRecord', () => {
    test('returns true for object records', () => {
      expect(isRecord({})).toBe(true);
      expect(isRecord({ a: 1 })).toBe(true);
      expect(isRecord(Object.create(null))).toBe(true);
      expect(isRecord(new (class Foo {})())).toBe(true);
    });

    test('returns false for primitives, null, undefined, and arrays', () => {
      expect(isRecord(null)).toBe(false);
      expect(isRecord(undefined)).toBe(false);
      expect(isRecord(123)).toBe(false);
      expect(isRecord('string')).toBe(false);
      expect(isRecord(true)).toBe(false);
      expect(isRecord(Symbol('sym'))).toBe(false);
      expect(isRecord([1, 2, 3])).toBe(false);
      expect(isRecord([])).toBe(false);
    });
  });

  describe('isPlainRecord', () => {
    test('returns true for plain objects and Object.create(null)', () => {
      expect(isPlainRecord({})).toBe(true);
      expect(isPlainRecord({ a: 1 })).toBe(true);
      expect(isPlainRecord(Object.create(null))).toBe(true);
    });

    test('returns false for class instances, arrays, primitives, and null', () => {
      class CustomClass {}
      expect(isPlainRecord(new CustomClass())).toBe(false);
      expect(isPlainRecord([])).toBe(false);
      expect(isPlainRecord(null)).toBe(false);
      expect(isPlainRecord(undefined)).toBe(false);
      expect(isPlainRecord(123)).toBe(false);
      expect(isPlainRecord('hello')).toBe(false);
    });
  });

  describe('isPromiseLike', () => {
    test('returns true for Promise instances and thenable objects', () => {
      expect(isPromiseLike(Promise.resolve())).toBe(true);
      expect(isPromiseLike(new Promise(() => {}))).toBe(true);
      expect(isPromiseLike({ then: () => {} })).toBe(true);
    });

    test('returns false for non-thenables and primitives', () => {
      expect(isPromiseLike(undefined)).toBe(false);
      expect(isPromiseLike(null)).toBe(false);
      expect(isPromiseLike({})).toBe(false);
      expect(isPromiseLike({ catch: () => {} })).toBe(false);
      expect(isPromiseLike('then')).toBe(false);
      expect(isPromiseLike(123)).toBe(false);
      expect(isPromiseLike(() => {})).toBe(false);
    });
  });
});
