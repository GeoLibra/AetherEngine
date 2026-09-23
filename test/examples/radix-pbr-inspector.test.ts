import { describe, expect, test } from 'vitest';
import { StandardLitMaterialSchema } from '../../src';
import {
  createMaterialPanelLayout,
  createMaterialPanelValue
} from '../../examples/react-vite-ts/src/demos/pbr-inspector/material-power-panel';

describe('Radix PBR inspector schema', () => {
  test('derives PowerPanel slider declarations from the engine material schema', () => {
    const layout = createMaterialPanelLayout(StandardLitMaterialSchema.typeSchema);

    expect(layout).toEqual([
      [
        expect.objectContaining({ type: 'Slider', path: 'metallic', title: 'Metallic' }),
        expect.objectContaining({ type: 'Slider', path: 'roughness', title: 'Roughness' })
      ],
      [
        expect.objectContaining({ type: 'Slider', path: 'normalScale', title: 'Normal scale' }),
        expect.objectContaining({
          type: 'Slider',
          path: 'occlusionStrength',
          title: 'Occlusion'
        })
      ]
    ]);
  });

  test('derives initial values from the engine material schema defaults', () => {
    expect(createMaterialPanelValue(StandardLitMaterialSchema.typeSchema)).toEqual({
      metallic: 0,
      roughness: 0.5,
      normalScale: 1,
      occlusionStrength: 1
    });
    expect(Object.isFrozen(createMaterialPanelValue(StandardLitMaterialSchema.typeSchema))).toBe(
      true
    );
  });
});
