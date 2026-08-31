import { describe, expect, test } from 'vitest';
import * as Aether from '../../src';

describe('rendering public API', () => {
  test('does not publish RenderWorld snapshot implementation helpers', () => {
    for (const name of [
      'FROZEN_MAP_INNERS',
      'FrozenMap',
      'changeRank',
      'copyCommittedFields',
      'freezeFields',
      'frozenDiff',
      'packEntity',
      'stableValueEqual',
      'unpackIndex',
      'copyRenderFieldValue',
      'snapshotRenderFieldValue',
      'ReadonlyMapSnapshot',
      'ReadonlySetSnapshot'
    ]) {
      expect(name in Aether, `${name} must remain internal`).toBe(false);
    }
  });
});
