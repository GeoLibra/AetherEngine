import { describe, expect, test } from 'vitest';

import { decrementLeaseCount } from '../../../src/rhi/webgl2/resources/lease-count';

describe('WebGL2 lease count invariants', () => {
  test('rejects release without a matching retain', () => {
    expect(() => decrementLeaseCount(undefined, 'buffer')).toThrow(
      'Cannot release WebGL2 resource "buffer" without a matching retain.'
    );
  });

  test('returns the remaining lease count', () => {
    expect(decrementLeaseCount(2, 'buffer')).toBe(1);
    expect(decrementLeaseCount(1, 'buffer')).toBe(0);
  });
});
