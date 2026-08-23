import { describe, expect, test } from 'vitest';
import {
  compileMaterialBindingLayout,
  createShaderBindingManifest,
  defineMaterialSchema,
  type ShaderModuleIR
} from '../../src';

const span = { uri: 'asset://shader/binding-identity', line: 1, column: 1, length: 1 } as const;

describe('Material binding layout identity', () => {
  test('canonicalizes reflection insertion order and freezes published identity', () => {
    const schema = defineMaterialSchema({
      id: 'material.binding-identity',
      version: 1,
      fields: {
        texture: {
          fieldId: 'texture',
          name: 'texture',
          valueType: { kind: 'texture-reference' },
          defaultValue: { kind: 'texture', assetId: 'default-texture' },
          bindingPath: 'surfaceTexture'
        },
        sampler: {
          fieldId: 'sampler',
          name: 'sampler',
          valueType: { kind: 'sampler-reference' },
          defaultValue: { kind: 'sampler', assetId: 'default-sampler' },
          bindingPath: 'surfaceSampler'
        }
      }
    });
    const first = compileMaterialBindingLayout(
      schema,
      manifest(['surfaceTexture', 'surfaceSampler'])
    );
    const second = compileMaterialBindingLayout(
      schema,
      manifest(['surfaceSampler', 'surfaceTexture'])
    );

    expect(first.identity.canonicalValue).toBe(second.identity.canonicalValue);
    expect(first.identity.hash).toBe(second.identity.hash);
    expect(Object.isFrozen(first.identity)).toBe(true);
    expect(Object.isFrozen(first.identity.parts)).toBe(true);
    expect(Object.isFrozen(first.identity.parts.entries)).toBe(true);
  });

  test('changes identity when a binding compatibility dimension changes', () => {
    const schema = defineMaterialSchema({
      id: 'material.binding-dimension',
      version: 1,
      fields: {
        texture: {
          fieldId: 'texture',
          name: 'texture',
          valueType: { kind: 'texture-reference' },
          defaultValue: { kind: 'texture', assetId: 'default-texture' },
          bindingPath: 'surfaceTexture'
        }
      }
    });
    const texture2d = compileMaterialBindingLayout(schema, manifest(['surfaceTexture'], false));
    const textureCube = compileMaterialBindingLayout(schema, manifest(['surfaceTexture'], true));

    expect(texture2d.identity.hash).not.toBe(textureCube.identity.hash);
  });
});

function manifest(order: readonly string[], cube = false) {
  const globals: ShaderModuleIR['globals'] = order.map((name) => ({
    name,
    type: name === 'surfaceSampler' ? 'sampler' : cube ? 'texture_cube<f32>' : 'texture_2d<f32>',
    addressSpace: 'handle',
    access: 'read',
    group: name === 'surfaceSampler' ? 2 : 1,
    binding: name === 'surfaceSampler' ? 1 : 0,
    span
  }));
  return createShaderBindingManifest(
    {
      version: 1,
      types: [],
      globals,
      functions: [],
      entryPoints: [],
      variants: [],
      sourceMap: { spans: [] },
      sourceClosureHash: 'binding-identity'
    },
    1
  );
}
