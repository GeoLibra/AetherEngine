import { describe, expect, test } from 'vitest';
import { SchemaRegistry, defineSchema } from '../../src';

interface ReferenceDocument {
  target: { kind: 'entity'; id: string };
  textures: Array<{ kind: 'asset'; id: string }>;
  weights: Float32Array;
}

const ReferenceSchema = defineSchema<ReferenceDocument>({
  id: 'test.references',
  version: 1,
  kind: 'document',
  fields: [
    {
      id: 'target-entity',
      name: 'target',
      type: { kind: 'entity-ref', policy: 'required' },
      required: true,
      compare: 'identity',
      serialization: 'save'
    },
    {
      id: 'texture-assets',
      name: 'textures',
      type: {
        kind: 'array',
        element: { kind: 'asset-ref', policy: 'soft', expectedType: 'asset.texture' }
      },
      required: true,
      compare: 'shallow',
      serialization: 'save'
    },
    {
      id: 'weights',
      name: 'weights',
      type: { kind: 'vector', length: 2 },
      required: true,
      compare: 'exact',
      serialization: 'save'
    }
  ],
  validate(input) {
    return { ok: true, value: input as ReferenceDocument };
  }
});

describe('Schema reference traversal', () => {
  test('walks and remaps references through stable field paths without aliasing values', () => {
    const registry = new SchemaRegistry();
    registry.register(ReferenceSchema);
    const source = {
      target: { kind: 'entity' as const, id: 'entity-old' },
      textures: [{ kind: 'asset' as const, id: 'texture-old' }],
      weights: new Float32Array([0.25, 0.75])
    };
    const visited: Array<{
      path: readonly unknown[];
      policy: string;
      id: string;
      expectedType?: string;
    }> = [];

    registry.visitReferences('test.references', 1, source, (visit) => {
      visited.push({
        path: visit.path,
        policy: visit.policy,
        id: visit.reference.id,
        ...(visit.expectedType === undefined ? {} : { expectedType: visit.expectedType })
      });
    });
    const cloned = registry.clone('test.references', 1, source);
    const remapped = registry.mapReferences('test.references', 1, source, (visit) => ({
      ...visit.reference,
      id: `${visit.reference.id}-new`
    }));

    expect(visited).toEqual([
      { path: [{ kind: 'field', id: 'target-entity' }], policy: 'required', id: 'entity-old' },
      {
        path: [
          { kind: 'field', id: 'texture-assets' },
          { kind: 'array', index: 0 }
        ],
        policy: 'soft',
        id: 'texture-old',
        expectedType: 'asset.texture'
      }
    ]);
    expect(remapped).toEqual({
      target: { kind: 'entity', id: 'entity-old-new' },
      textures: [{ kind: 'asset', id: 'texture-old-new' }],
      weights: new Float32Array([0.25, 0.75])
    });
    expect(source.target.id).toBe('entity-old');
    expect(cloned).toEqual(source);
    expect(cloned).not.toBe(source);
    expect(cloned.weights).not.toBe(source.weights);
    expect(remapped).not.toBe(source);
    expect(() =>
      registry.mapReferences('test.references', 1, source, (visit) =>
        visit.policy === 'required' ? null : visit.reference
      )
    ).toThrow('required');
  });
});
