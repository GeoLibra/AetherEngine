import { describe, expect, test } from 'vitest';
import {
  defineObjectComponent,
  defineTagComponent,
  World
} from '../../src';

interface MetadataView {
  label: string;
  items: string[];
}

const Metadata = defineObjectComponent<MetadataView>({
  id: 'test.metadata',
  version: 1,
  name: 'Metadata',
  fields: [
    {
      id: 'label',
      name: 'label',
      type: { kind: 'string' },
      required: true,
      compare: 'exact',
      serialization: 'save'
    },
    {
      id: 'items',
      name: 'items',
      type: { kind: 'array', element: { kind: 'string' } },
      required: true,
      defaultValue: [],
      compare: 'shallow',
      serialization: 'save'
    }
  ],
  validate(input) {
    if (
      typeof input !== 'object' ||
      input === null ||
      !('label' in input) ||
      typeof input.label !== 'string' ||
      !('items' in input) ||
      !Array.isArray(input.items) ||
      !input.items.every((item) => typeof item === 'string')
    ) {
      return { ok: false, issues: [{ path: [], message: 'Invalid metadata.' }] };
    }
    return { ok: true, value: input as MetadataView };
  }
});

const Selected = defineTagComponent({
  id: 'test.selected',
  version: 1,
  name: 'Selected'
});

describe('Schema-driven ECS component storage', () => {
  test('stores object components sparsely without caller aliasing', () => {
    const world = new World();
    world.registerComponent(Metadata);
    const entity = world.spawn().build();
    const source = { label: 'hero', items: ['sword'] };

    world.insertComponent(entity, Metadata, source);
    source.items.push('caller-only');

    expect(world.getComponent(entity, Metadata)).toEqual({
      label: 'hero',
      items: ['sword']
    });
    expect([...world.query([Metadata])].map(([id, value]) => [id, value.label])).toEqual([
      [entity, 'hero']
    ]);
  });

  test('supports explicit object change marking and removal tombstones', () => {
    const world = new World();
    world.registerComponent(Metadata);
    const entity = world.spawn().insert(Metadata, { label: 'hero' }).build();
    world.clearTrackers();

    world.getComponent(entity, Metadata)!.items.push('shield');
    world.markComponentChanged(entity, Metadata);

    expect([...world.query([Metadata], { changed: [Metadata] })]).toHaveLength(1);
    expect(world.removeComponent(entity, Metadata)).toBe(true);
    expect(world.readRemoved(Metadata).map((entry) => entry.entity)).toEqual([entity]);
  });

  test('keeps tag components payload-free in archetype signatures', () => {
    const world = new World();
    world.registerComponent(Metadata).registerComponent(Selected);
    const selected = world
      .spawn()
      .insert(Metadata, { label: 'selected' })
      .insert(Selected)
      .build();
    world.spawn().insert(Metadata, { label: 'plain' }).build();

    expect(world.hasComponent(selected, Selected)).toBe(true);
    expect([...world.query([Metadata], { with: [Selected] })].map(([id]) => id)).toEqual([
      selected
    ]);
    expect([...world.query([Selected])].map(([id]) => id)).toEqual([selected]);
    expect(world.removeComponent(selected, Selected)).toBe(true);
    expect([...world.query([Selected])]).toHaveLength(0);
  });
});
