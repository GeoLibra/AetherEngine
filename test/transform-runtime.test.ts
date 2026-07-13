import { describe, expect, test } from 'vitest';
import {
  ChildOf,
  LocalTransform,
  Mat4,
  normalizeWorldPosition,
  TransformRuntime,
  World,
  WorldOrigin,
  WorldTransform,
  type Entity
} from '../src';

describe('TransformRuntime', () => {
  test('propagates parent-before-child and preserves previous matrices', () => {
    const world = new World();
    const transforms = TransformRuntime.install(world);
    const parent = world.spawn().build();
    const child = world.spawn().build();
    transforms.attach(parent, { translation: [10, 0, 0] });
    transforms.attach(child, { translation: [0, 2, 0] });
    transforms.reparent(child, parent, 'keep-local');

    const first = transforms.propagate();
    const initial = world.getComponent(child, WorldTransform)!;

    expect(first.propagated).toBe(2);
    expectVector(Mat4.transformPoint(initial.matrix, [0, 0, 0]), [10, 2, 0]);
    const firstMatrix = new Float32Array(initial.matrix);

    transforms.setLocal(parent, { translation: [20, 0, 0] });
    transforms.propagate();
    const updated = world.getComponent(child, WorldTransform)!;

    expectVector(Mat4.transformPoint(updated.matrix, [0, 0, 0]), [20, 2, 0]);
    expect(Array.from(updated.previousMatrix)).toEqual(Array.from(firstMatrix));
    expect(updated.worldVersion).toBeGreaterThan(initial.worldVersion - 1);
  });

  test('supports transactional keep-world and keep-local reparenting', () => {
    const world = new World();
    const transforms = TransformRuntime.install(world);
    const firstParent = world.spawn().build();
    const secondParent = world.spawn().build();
    const child = world.spawn().build();
    transforms.attach(firstParent, { translation: [10, 0, 0] });
    transforms.attach(secondParent, { translation: [20, 0, 0] });
    transforms.attach(child, { translation: [2, 0, 0] });
    transforms.reparent(child, firstParent, 'keep-local');
    transforms.propagate();

    transforms.reparent(child, secondParent, 'keep-world');
    transforms.propagate();
    expectVector(
      Mat4.transformPoint(world.getComponent(child, WorldTransform)!.matrix, [0, 0, 0]),
      [12, 0, 0]
    );
    expectVector(world.getComponent(child, LocalTransform)!.translation, [-8, 0, 0]);

    transforms.reparent(child, firstParent, 'keep-local');
    transforms.propagate();
    expectVector(
      Mat4.transformPoint(world.getComponent(child, WorldTransform)!.matrix, [0, 0, 0]),
      [2, 0, 0]
    );
  });

  test('requires an explicit parent despawn policy', () => {
    const world = new World();
    const transforms = TransformRuntime.install(world);
    const parent = world.spawn().build();
    const child = world.spawn().build();
    transforms.attach(parent, { translation: [10, 0, 0] });
    transforms.attach(child, { translation: [2, 0, 0] });
    transforms.reparent(child, parent, 'keep-local');
    transforms.propagate();

    expect(() => transforms.despawn(parent, 'reject-if-children')).toThrow('children');
    expect(transforms.despawn(parent, 'detach-keep-world')).toBe(true);

    expect(world.isAlive(parent)).toBe(false);
    expect(world.getParent(child)).toBeNull();
    expectVector(
      Mat4.transformPoint(world.getComponent(child, WorldTransform)!.matrix, [0, 0, 0]),
      [12, 0, 0]
    );
  });

  test('rejects keep-world reparent to a singular parent without changing relation', () => {
    const world = new World();
    const transforms = TransformRuntime.install(world);
    const oldParent = world.spawn().build();
    const singularParent = world.spawn().build();
    const child = world.spawn().build();
    transforms.attach(oldParent);
    transforms.attach(singularParent, { scale: [0, 1, 1] });
    transforms.attach(child, { translation: [1, 0, 0] });
    transforms.reparent(child, oldParent, 'keep-local');
    transforms.propagate();

    expect(() => transforms.reparent(child, singularParent, 'keep-world')).toThrow(
      'singular'
    );
    expect(world.getParent(child)).toBe(oldParent);
  });

  test('derives inverse-transpose normal matrix and determinant sign', () => {
    const world = new World();
    const transforms = TransformRuntime.install(world);
    const entity = world.spawn().build();
    transforms.attach(entity, { scale: [-2, 3, 4] });

    transforms.propagate();
    const derived = world.getComponent(entity, WorldTransform)!;

    expect(derived.determinantSign).toBe(-1);
    expectVector(derived.normalMatrix, [-0.5, 0, 0, 0, 1 / 3, 0, 0, 0, 0.25]);
  });

  test('extracts interpolated camera-relative render snapshots without mutating MainWorld', () => {
    const world = new World();
    const transforms = TransformRuntime.install(world);
    const entity = world.spawn().build();
    transforms.attach(entity, { translation: [0, 0, 0] });
    transforms.propagate();
    transforms.setLocal(entity, { translation: [10, 0, 0] });
    transforms.propagate();
    const authoritative = new Float32Array(
      world.getComponent(entity, WorldTransform)!.matrix
    );

    const extracted = transforms.extract({
      interpolationAlpha: 0.25,
      camera: { cell: [0, 0, 0], offset: [1, 0, 0] }
    });

    expectVector(
      Mat4.transformPoint(extracted.get(entity)!.matrix, [0, 0, 0]),
      [1.5, 0, 0]
    );
    expect(Array.from(world.getComponent(entity, WorldTransform)!.matrix)).toEqual(
      Array.from(authoritative)
    );
  });

  test('derives render normal data from the interpolated matrix', () => {
    const world = new World();
    const transforms = TransformRuntime.install(world);
    const entity = world.spawn().build();
    transforms.attach(entity, { scale: [1, 1, 1] });
    transforms.propagate();
    transforms.setLocal(entity, { scale: [3, 3, 3] });
    transforms.propagate();

    const rendered = transforms.extract({ interpolationAlpha: 0.5 }).get(entity)!;

    expectVector(rendered.normalMatrix, [0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5]);
    expect(rendered.determinantSign).toBe(1);
  });

  test('teleport resets previous transform and reports a history reset reason', () => {
    const world = new World();
    const transforms = TransformRuntime.install(world);
    const entity = world.spawn().build();
    transforms.attach(entity);
    transforms.propagate();

    transforms.teleport(entity, { translation: [100, 0, 0] });
    transforms.propagate();

    const derived = world.getComponent(entity, WorldTransform)!;
    expect(Array.from(derived.previousMatrix)).toEqual(Array.from(derived.matrix));
    expect(transforms.history.reason).toBe('teleport');
  });

  test('rebases root transforms at a frame boundary and resets temporal history', () => {
    const world = new World();
    const transforms = TransformRuntime.install(world, { cellSize: 100 });
    const root = world.spawn().build();
    const child = world.spawn().build();
    transforms.attach(root, { translation: [125, 0, 0] });
    transforms.attach(child, { translation: [5, 0, 0] });
    transforms.reparent(child, root, 'keep-local');
    transforms.propagate();

    expect(transforms.rebase([1, 0, 0])).toBe(true);

    expectVector(world.getResource(WorldOrigin)!.cell, [1, 0, 0]);
    expectVector(world.getComponent(root, LocalTransform)!.translation, [25, 0, 0]);
    expectVector(world.getComponent(child, LocalTransform)!.translation, [5, 0, 0]);
    expectVector(
      Mat4.transformPoint(world.getComponent(child, WorldTransform)!.matrix, [0, 0, 0]),
      [30, 0, 0]
    );
    expect(transforms.history.reason).toBe('origin-rebase');
    expect(
      Array.from(world.getComponent(child, WorldTransform)!.previousMatrix)
    ).toEqual(Array.from(world.getComponent(child, WorldTransform)!.matrix));
  });

  test('normalizes cell plus offset positions with stable absolute coordinates', () => {
    const normalized = normalizeWorldPosition(
      { cell: [3, -2, 0], offset: [175, -151, 49] },
      100
    );

    expect(normalized).toEqual({ cell: [5, -4, 0], offset: [-25, 49, 49] });
  });

  test('propagates a deep hierarchy without recursive stack growth', () => {
    const world = new World();
    const transforms = TransformRuntime.install(world);
    let parent: Entity | undefined;
    let last!: Entity;
    for (let index = 0; index < 512; index++) {
      const entity = world.spawn().build();
      transforms.attach(entity, { translation: [1, 0, 0] });
      if (parent !== undefined) {
        world.addRelation(entity, ChildOf, parent);
      }
      parent = entity;
      last = entity;
    }

    const stats = transforms.propagate();

    expect(stats).toMatchObject({ dirtyRoots: 1, propagated: 512, maxDepth: 511 });
    expectVector(
      Mat4.transformPoint(world.getComponent(last, WorldTransform)!.matrix, [0, 0, 0]),
      [512, 0, 0]
    );
  });
});

function expectVector(
  actual: ArrayLike<number>,
  expected: readonly number[],
  digits = 5
): void {
  expect(actual.length).toBe(expected.length);
  expected.forEach((value, index) => expect(actual[index]).toBeCloseTo(value, digits));
}
