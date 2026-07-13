import { describe, expect, test } from 'vitest';
import {
  applyPrefabOverride,
  createPrefabOverridePath,
  defineSchema,
  ReferenceResolutionError,
  SchemaRegistry
} from '../src';

interface LinkDocument {
  target: { kind: 'entity'; id: string };
}

const LinkSchema = defineSchema<LinkDocument>({
  id: 'test.link-document',
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
    }
  ],
  validate(input) {
    if (
      typeof input === 'object' &&
      input !== null &&
      'target' in input &&
      typeof input.target === 'object' &&
      input.target !== null &&
      'kind' in input.target &&
      input.target.kind === 'entity' &&
      'id' in input.target &&
      typeof input.target.id === 'string'
    ) {
      return { ok: true, value: input as LinkDocument };
    }
    return {
      ok: false,
      issues: [{ path: ['target-entity'], message: 'Invalid target.' }]
    };
  }
});

interface PrefabDocument {
  slots: Array<{
    slotId: string;
    target: { kind: 'entity'; id: string };
  }>;
}

const PrefabSchema = defineSchema<PrefabDocument>({
  id: 'test.prefab-document',
  version: 1,
  kind: 'document',
  fields: [
    {
      id: 'slots',
      name: 'slots',
      type: {
        kind: 'array',
        elementKey: 'slot-id',
        element: {
          kind: 'struct',
          fields: [
            {
              id: 'slot-id',
              name: 'slotId',
              type: { kind: 'string' },
              required: true,
              compare: 'exact',
              serialization: 'save'
            },
            {
              id: 'target-entity',
              name: 'target',
              type: { kind: 'entity-ref', policy: 'required' },
              required: true,
              compare: 'identity',
              serialization: 'save'
            }
          ]
        }
      },
      required: true,
      compare: 'shallow',
      serialization: 'save'
    }
  ],
  validate: (input) => ({ ok: true, value: input as PrefabDocument })
});

describe('Schema reference transactions and Prefab paths', () => {
  test('returns an all-or-nothing reference batch after required references resolve', () => {
    const registry = new SchemaRegistry();
    registry.register(LinkSchema);
    const first = { target: { kind: 'entity' as const, id: 'first' } };
    const missing = { target: { kind: 'entity' as const, id: 'missing' } };

    expect(() =>
      registry.resolveReferenceTransaction(
        [
          { key: 'first', schema: 'test.link-document', version: 1, value: first },
          { key: 'second', schema: 'test.link-document', version: 1, value: missing }
        ],
        (visit) =>
          visit.reference.id === 'missing'
            ? null
            : { ...visit.reference, id: `runtime-${visit.reference.id}` }
      )
    ).toThrow(ReferenceResolutionError);
    expect(first.target.id).toBe('first');

    const resolved = registry.resolveReferenceTransaction(
      [{ key: 'first', schema: 'test.link-document', version: 1, value: first }],
      (visit) => ({ ...visit.reference, id: `runtime-${visit.reference.id}` })
    );
    expect(resolved).toEqual([
      {
        key: 'first',
        schema: 'test.link-document',
        version: 1,
        value: { target: { kind: 'entity', id: 'runtime-first' } }
      }
    ]);
    expect(() =>
      registry.resolveReferenceTransaction(
        [
          {
            key: 'invalid',
            schema: 'test.link-document',
            version: 1,
            value: { target: { kind: 'entity', id: 42 } }
          }
        ],
        (visit) => visit.reference
      )
    ).toThrow('validation');
  });

  test('applies Prefab overrides through stable field and element keys', () => {
    const source: PrefabDocument = {
      slots: [
        { slotId: 'right', target: { kind: 'entity', id: 'old-right' } },
        { slotId: 'left', target: { kind: 'entity', id: 'old-left' } }
      ]
    };
    const path = createPrefabOverridePath({
      localEntityId: 'child-7',
      schema: 'test.prefab-document',
      segments: [
        { kind: 'field', id: 'slots' },
        { kind: 'element', key: 'right' },
        { kind: 'field', id: 'target-entity' }
      ]
    });

    const result = applyPrefabOverride(PrefabSchema, source, path, {
      kind: 'entity',
      id: 'new-right'
    });

    expect(result.slots[0]?.target.id).toBe('new-right');
    expect(result.slots[1]?.target.id).toBe('old-left');
    expect(source.slots[0]?.target.id).toBe('old-right');
    expect(() =>
      applyPrefabOverride(
        PrefabSchema,
        {
          slots: [
            { slotId: 'right', target: { kind: 'entity', id: 'first' } },
            { slotId: 'right', target: { kind: 'entity', id: 'duplicate' } }
          ]
        },
        path,
        { kind: 'entity', id: 'ambiguous' }
      )
    ).toThrow('duplicate stable element key');
    expect(() =>
      createPrefabOverridePath({
        localEntityId: 'child-7',
        schema: 'test.prefab-document',
        segments: [{ kind: 'array', index: 0 }] as never
      })
    ).toThrow('array index');
  });
});
