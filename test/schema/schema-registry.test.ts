import { describe, expect, test } from 'vitest';
import {
  SchemaRegistry,
  SchemaRegistryResource,
  SchemaValidationError,
  World,
  defineComponent,
  defineSchema
} from '../../src';

interface PositionDocument {
  x: number;
  y: number;
}

const PositionV1 = defineSchema<PositionDocument>({
  id: 'test.position',
  version: 1,
  kind: 'document',
  fields: [
    {
      id: 'x',
      name: 'x',
      type: { kind: 'number', format: 'f32' },
      required: true,
      compare: 'exact',
      serialization: 'save'
    },
    {
      id: 'y',
      name: 'y',
      type: { kind: 'number', format: 'f32' },
      required: true,
      compare: 'exact',
      serialization: 'save'
    }
  ],
  validate(input) {
    if (
      typeof input === 'object' &&
      input !== null &&
      typeof Reflect.get(input, 'x') === 'number' &&
      typeof Reflect.get(input, 'y') === 'number'
    ) {
      return { ok: true, value: input as PositionDocument };
    }
    return { ok: false, issues: [{ path: [], message: 'Expected x/y numbers.' }] };
  }
});

describe('SchemaRegistry', () => {
  test('is the single schema authority for ECS components in a World', () => {
    const component = defineComponent<{ x: number }>({
      id: 'test.ecs-position',
      version: 1,
      name: 'Position',
      fields: [{ id: 'x-coordinate', name: 'x', type: 'f32' }]
    });
    const world = new World();

    world.registerComponent(component);

    const registry = world.getResource(SchemaRegistryResource);
    expect(registry).toBeInstanceOf(SchemaRegistry);
    expect(registry?.get('test.ecs-position', 1)).toBe(component);
    expect(component.fields[0]).toMatchObject({
      id: 'x-coordinate',
      name: 'x',
      type: { kind: 'number', format: 'f32' },
      packedType: 'f32'
    });
    expect(() => world.insertResource(SchemaRegistryResource, new SchemaRegistry())).toThrow(
      'already registered'
    );
    expect(() => world.replaceResource(SchemaRegistryResource, new SchemaRegistry())).toThrow(
      'cannot be replaced'
    );
    expect(() => world.removeResource(SchemaRegistryResource)).toThrow('cannot be removed');
  });

  test('registers typed schemas with stable runtime type and field indexes', () => {
    const registry = new SchemaRegistry();

    const registration = registry.register(PositionV1);

    expect(registration.typeIndex).toBe(0);
    expect(registry.get<PositionDocument>('test.position', 1)).toBe(PositionV1);
    expect(registry.getLatest<PositionDocument>('test.position')).toBe(PositionV1);
    expect(registry.getTypeIndex('test.position', 1)).toBe(0);
    expect(registry.getFieldIndex('test.position', 1, 'x')).toBe(0);
    expect(registry.getFieldIndex('test.position', 1, 'y')).toBe(1);
    expect(Object.isFrozen(PositionV1)).toBe(true);
    expect(Object.isFrozen(PositionV1.fields)).toBe(true);
  });

  test('rejects invalid defaults and reports typed payload validation errors', () => {
    expect(() =>
      defineSchema({
        id: 'test.invalid-default',
        version: 1,
        kind: 'document',
        fields: [
          {
            id: 'count',
            name: 'count',
            type: { kind: 'number', format: 'u32' },
            required: true,
            defaultValue: 'not-a-number',
            compare: 'exact',
            serialization: 'save'
          }
        ],
        validate: (input) => ({ ok: true, value: input })
      })
    ).toThrow('default');

    const registry = new SchemaRegistry();
    registry.register(PositionV1);

    expect(() =>
      registry.decodePayload({
        schema: 'test.position',
        version: 1,
        fields: { x: 1, y: 'invalid' }
      })
    ).toThrow(SchemaValidationError);
  });

  test('accepts nested struct definitions without branded authoring casts', () => {
    const schema = defineSchema({
      id: 'test.nested-struct',
      version: 1,
      kind: 'document',
      fields: [
        {
          id: 'metadata',
          name: 'metadata',
          type: {
            kind: 'struct',
            fields: [
              {
                id: 'owner-entity',
                name: 'owner',
                type: { kind: 'entity-ref', policy: 'optional' },
                required: false,
                compare: 'identity',
                serialization: 'save'
              }
            ]
          },
          required: true,
          defaultValue: {},
          compare: 'shallow',
          serialization: 'save'
        }
      ],
      validate: (input) => ({ ok: true, value: input })
    });

    expect(schema.fields[0]?.type).toMatchObject({
      kind: 'struct',
      fields: [{ id: 'owner-entity', name: 'owner' }]
    });
    expect(Object.isFrozen(schema.fields[0]?.type)).toBe(true);
  });

  test('reference-counts identical registrations and rejects conflicting contracts', () => {
    const registry = new SchemaRegistry();
    const first = registry.register(PositionV1);
    const second = registry.register(PositionV1);
    const conflict = defineSchema<PositionDocument>({
      id: 'test.position',
      version: 1,
      kind: 'document',
      fields: PositionV1.fields.map((field) => ({ ...field, id: String(field.id) })),
      validate: PositionV1.validate
    });

    expect(() => registry.register(conflict)).toThrow('different contract');
    expect(first.remove()).toBe(true);
    expect(registry.get('test.position', 1)).toBe(PositionV1);
    expect(second.remove()).toBe(true);
    expect(registry.get('test.position', 1)).toBeUndefined();
    expect(second.remove()).toBe(false);
  });

  test('derives serialization, editor, and explicit replication views', () => {
    const schema = defineSchema<Record<string, unknown>>({
      id: 'test.schema-views',
      version: 1,
      kind: 'resource',
      fields: [
        {
          id: 'saved',
          name: 'saved',
          type: { kind: 'number', format: 'f32' },
          required: true,
          compare: 'exact',
          serialization: 'save'
        },
        {
          id: 'runtime',
          name: 'runtime',
          type: { kind: 'number', format: 'f32' },
          required: false,
          compare: 'exact',
          serialization: 'runtime-only'
        },
        {
          id: 'replicated',
          name: 'replicated',
          type: { kind: 'number', format: 'f32' },
          required: true,
          compare: 'epsilon',
          serialization: 'save',
          replication: { authority: 'server', reliability: 'unreliable', frequency: 20 }
        }
      ],
      validate(input) {
        return { ok: true, value: input as Record<string, unknown> };
      }
    });
    const registry = new SchemaRegistry();
    registry.register(schema);

    expect(
      registry.getView('test.schema-views', 1, 'serialization')?.fields.map((f) => f.id)
    ).toEqual(['saved', 'replicated']);
    expect(registry.getView('test.schema-views', 1, 'editor')?.fields.map((f) => f.id)).toEqual([
      'saved',
      'runtime',
      'replicated'
    ]);
    expect(
      registry.getView('test.schema-views', 1, 'replication')?.fields.map((f) => f.id)
    ).toEqual(['replicated']);
  });

  test('migrates through a continuous version chain without mutating source data', () => {
    const v2 = defineSchema<PositionDocument & { z: number }>({
      id: 'test.position',
      version: 2,
      kind: 'document',
      fields: [
        ...PositionV1.fields.map((field) => ({ ...field, id: String(field.id) })),
        {
          id: 'z',
          name: 'z',
          type: { kind: 'number', format: 'f32' },
          required: true,
          defaultValue: 0,
          compare: 'exact',
          serialization: 'save'
        }
      ],
      validate(input) {
        return { ok: true, value: input as PositionDocument & { z: number } };
      }
    });
    const registry = new SchemaRegistry();
    registry.register(PositionV1);
    registry.register(v2);
    registry.registerMigration({
      schema: 'test.position',
      from: 1,
      to: 2,
      migrate(input) {
        expect(Object.isFrozen(input)).toBe(true);
        return {
          value: { ...input, z: 0 },
          warnings: [{ code: 'defaulted-z', message: 'Added the z default.', path: ['z'] }]
        };
      }
    });
    const source = { x: 1, y: 2 };

    const migrated = registry.migrate('test.position', 1, 2, source);

    expect(migrated.value).toEqual({ x: 1, y: 2, z: 0 });
    expect(migrated.warnings).toEqual([
      { code: 'defaulted-z', message: 'Added the z default.', path: ['z'] }
    ]);
    expect(Object.isFrozen(migrated.warnings[0])).toBe(true);
    expect(Object.isFrozen(migrated.warnings[0]?.path)).toBe(true);
    expect(source).toEqual({ x: 1, y: 2 });
    expect(() =>
      registry.registerMigration({
        schema: 'test.position',
        from: 1,
        to: 3,
        migrate: (input) => ({ value: input, warnings: [] })
      })
    ).toThrow('continuous');
  });

  test('round-trips unknown fields and completely unknown schemas', () => {
    const registry = new SchemaRegistry();
    registry.register(PositionV1);
    const source = {
      schema: 'test.position',
      version: 1,
      fields: { x: 1, y: 2, 'future.plugin-value': { enabled: true } }
    } as const;

    const decoded = registry.decodePayload<PositionDocument>(source);

    expect(decoded).toMatchObject({
      kind: 'known',
      value: { x: 1, y: 2 },
      extensions: { 'future.plugin-value': { enabled: true } }
    });
    expect(registry.encodePayload(decoded)).toEqual(source);

    const unknownSource = {
      schema: 'missing.plugin-component',
      version: 7,
      fields: { arbitrary: ['preserved', 42] }
    } as const;
    const opaque = registry.decodePayload(unknownSource);

    expect(opaque.kind).toBe('opaque');
    expect(registry.encodePayload(opaque)).toEqual(unknownSource);
  });
});
