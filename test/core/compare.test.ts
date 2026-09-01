import { describe, expect, test } from 'vitest';
import { compareCodeUnits } from '../../src/core/utils/compare';

describe('core/compare', () => {
  describe('compareCodeUnits', () => {
    test('returns 0 for identical strings', () => {
      expect(compareCodeUnits('', '')).toBe(0);
      expect(compareCodeUnits('abc', 'abc')).toBe(0);
      expect(compareCodeUnits('hello_world', 'hello_world')).toBe(0);
    });

    test('returns -1 when left is lexicographically less than right', () => {
      expect(compareCodeUnits('a', 'b')).toBe(-1);
      expect(compareCodeUnits('abc', 'abd')).toBe(-1);
      expect(compareCodeUnits('', 'a')).toBe(-1);
      expect(compareCodeUnits('10', '2')).toBe(-1);
    });

    test('returns 1 when left is lexicographically greater than right', () => {
      expect(compareCodeUnits('b', 'a')).toBe(1);
      expect(compareCodeUnits('abd', 'abc')).toBe(1);
      expect(compareCodeUnits('a', '')).toBe(1);
      expect(compareCodeUnits('2', '10')).toBe(1);
    });

    test('correctly sorts arrays of strings identically to native default Array.prototype.sort', () => {
      const items = ['zebra', 'apple', 'banana', '123', 'Apple', 'beta', '', '0'];
      const sortedWithComparator = [...items].sort(compareCodeUnits);
      const sortedWithDefault = [...items].sort();

      expect(sortedWithComparator).toEqual(sortedWithDefault);
    });
  });
});
