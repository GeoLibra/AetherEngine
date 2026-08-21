import { describe, expect, test } from 'vitest';
import {
  MaterialAssetType,
  MeshAssetType,
  createAssetHandle,
  defineAssetType,
  validateAssetHandle
} from '../../src';

describe('typed asset handles', () => {
  test('creates stable serializable identities and preserves the expected type', () => {
    const handle = createAssetHandle(MeshAssetType, 'mesh:cube');
    expect(handle).toEqual({ assetId: 'mesh:cube', type: 'asset.geometry-mesh' });
    expect(Object.isFrozen(handle)).toBe(true);
    expect(validateAssetHandle(handle, MeshAssetType)).toEqual(handle);
  });

  test('rejects invalid IDs and cross-type handle substitution', () => {
    expect(() => defineAssetType('mesh')).toThrow(/namespaced/i);
    expect(() => createAssetHandle(MeshAssetType, ' ')).toThrow(/non-empty/i);
    expect(() =>
      validateAssetHandle(createAssetHandle(MaterialAssetType, 'material:default'), MeshAssetType)
    ).toThrow(/type/i);
  });
});
