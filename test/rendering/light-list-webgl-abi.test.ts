import { describe, expect, test } from 'vitest';
import {
  BUILT_IN_WEBGL2_TRANSLATOR,
  LIGHT_LIST_WEBGL2_SHADER_ARTIFACT,
  LIGHT_LIST_WEBGL_SHADER_ARTIFACT,
  decodeWebGlLightListOutput,
  packWebGlLightListInput,
  type RenderEntityId
} from '../../src';

const capacity = Object.freeze({
  maxDirectionalLights: 4,
  maxLightsPerReceiver: 4,
  maxLightIndices: 5
});

describe('WebGL2 light-list ABI', () => {
  test('publishes cooked integer-texture inputs and four unsigned outputs', () => {
    const fragment = LIGHT_LIST_WEBGL_SHADER_ARTIFACT.entryPoints.find(
      (entry) => entry.name === 'lightListFragment'
    );
    expect(fragment?.bindings.map(({ binding, kind }) => ({ binding, kind }))).toEqual([
      { binding: 0, kind: 'texture' },
      { binding: 1, kind: 'texture' }
    ]);
    expect(LIGHT_LIST_WEBGL_SHADER_ARTIFACT.fragmentOutputs).toHaveLength(4);
    expect(LIGHT_LIST_WEBGL2_SHADER_ARTIFACT).toBe(LIGHT_LIST_WEBGL_SHADER_ARTIFACT);
    const translated = BUILT_IN_WEBGL2_TRANSLATOR.translate({
      wgsl: LIGHT_LIST_WEBGL_SHADER_ARTIFACT.modules.wgsl,
      stage: 'fragment',
      entryPoint: 'lightListFragment',
      constants: {},
      capabilities: [],
      approvedExtensions: [],
      clipDepthMode: 'vertex-remap'
    });
    expect(translated.programBindings).toEqual([
      { kind: 'combined-sampler', name: '_group_0_binding_0_fs', slot: 0 },
      { kind: 'combined-sampler', name: '_group_0_binding_1_fs', slot: 1 }
    ]);
  });

  test('packs the shared word ABI into bounded RGBA32Uint input textures', () => {
    const packed = packWebGlLightListInput({
      viewLayerMask: 1,
      capacity,
      maxTextureDimension2D: 8,
      lights: [],
      receivers: [receiver(7), receiver(9)]
    });
    expect(packed.width).toBe(2);
    expect(packed.receiversHeight).toBe(4);
    expect([...packed.receivers.slice(0, 4)]).toEqual([2, 4, 4, 5]);
  });

  test('decodes fixed receiver slots into compact backend-neutral lists', () => {
    const width = 2;
    const height = 2;
    const words = () => new Uint32Array(width * height * 4);
    const directional = words();
    const headers = words();
    const indices = words();
    const overflow = words();
    directional.set([2, 4]);
    overflow[0] = 0x4000_0002;
    headers.set([7, 0, 3, 0x8000_0000], 0);
    headers.set([9, 3, 2, 0x8000_0001], 4);
    indices.set([1, 3, 5], 8);
    indices.set([7, 9], 12);

    expect(
      decodeWebGlLightListOutput({
        receiverCount: 2,
        capacity,
        width,
        directional,
        headers,
        indices,
        overflow
      })
    ).toEqual({
      directionalIndices: [2, 4],
      headers: [
        { receiver: 7, offset: 0, count: 3, overflowed: false },
        { receiver: 9, offset: 3, count: 2, overflowed: true }
      ],
      lightIndices: [1, 3, 5, 7, 9],
      overflowed: true
    });
  });
});

function receiver(renderEntity: number) {
  return {
    renderEntity: renderEntity as RenderEntityId,
    layerMask: 1,
    bounds: { kind: 'sphere' as const, center: [0, 0, 0] as const, radius: 1 }
  };
}
