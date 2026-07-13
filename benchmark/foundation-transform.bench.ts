import { bench, expect } from 'vitest';
import { ChildOf, Mat4, TransformRuntime, World, WorldTransform } from '../src';

bench(
  'propagates a 10K deep Transform hierarchy iteratively',
  () => {
    const world = new World();
    const transforms = TransformRuntime.install(world);
    let parent: number | undefined;
    let last = 0;
    for (let index = 0; index < 10_000; index++) {
      const entity = world.spawn().build();
      transforms.attach(entity, { translation: [1, 0, 0] });
      if (parent !== undefined) {
        world.addRelation(entity, ChildOf, parent);
      }
      parent = entity;
      last = entity;
    }

    const stats = transforms.propagate();
    const position = Mat4.transformPoint(
      world.getComponent(last, WorldTransform)!.matrix,
      [0, 0, 0]
    );
    expect(stats).toMatchObject({
      dirtyRoots: 1,
      propagated: 10_000,
      maxDepth: 9_999
    });
    expect(position[0]).toBeCloseTo(10_000);
  },
  { iterations: 1, warmupIterations: 0 }
);
