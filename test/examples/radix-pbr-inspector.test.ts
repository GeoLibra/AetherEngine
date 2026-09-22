import { describe, expect, test } from 'vitest';
import {
  PBR_INSPECTOR_SCHEMA,
  createPbrInspectorSnapshot,
  derivePbrInspectorGroups
} from '../../examples/react-vite-ts/src/demos/pbr-inspector/pbr-inspector-schema';

describe('Radix PBR inspector schema', () => {
  test('derives grouped slider controls from one material-oriented declaration', () => {
    const groups = derivePbrInspectorGroups(PBR_INSPECTOR_SCHEMA);

    expect(groups.map((group) => group.id)).toEqual(['surface', 'detail']);
    expect(groups[0]?.fields.map((field) => field.id)).toEqual(['metallic', 'roughness']);
    expect(groups[1]?.fields.map((field) => field.id)).toEqual([
      'normal-scale',
      'occlusion-strength'
    ]);
  });

  test('creates an immutable snapshot with the schema defaults', () => {
    expect(createPbrInspectorSnapshot()).toEqual({
      metallic: 0,
      roughness: 0.5,
      normalScale: 1,
      occlusionStrength: 1
    });
    expect(Object.isFrozen(createPbrInspectorSnapshot())).toBe(true);
  });
});
