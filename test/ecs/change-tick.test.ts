import { describe, expect, test } from 'vitest';
import { Schedule, World, defineComponent } from '../../src';

const Counter = defineComponent<{ value: number }>({
  id: 'test.change-counter',
  version: 1,
  name: 'ChangeCounter',
  fields: [{ id: 'value', name: 'value', type: 'u32' }]
});

describe('monotonic change tracking', () => {
  test('keeps independent per-system windows across different run frequencies', () => {
    const world = new World();
    world.registerComponent(Counter);
    const entity = world.spawn().insert(Counter, { value: 0 }).build();
    const schedule = new Schedule('Update');
    const fast: number[][] = [];
    const slow: number[][] = [];
    let frame = 0;

    schedule.addSystem({
      id: 'writer',
      run(currentWorld) {
        frame++;
        if (frame <= 2) {
          currentWorld.getComponent(entity, Counter)!.value = frame;
        }
      }
    });
    schedule.addSystem({
      id: 'fast-reader',
      after: ['writer'],
      run(currentWorld) {
        fast.push(
          [...currentWorld.query([Counter], { changed: [Counter] })].map(([changed]) => changed)
        );
      }
    });
    schedule.addSystem({
      id: 'slow-reader',
      after: ['fast-reader'],
      runIf: () => frame === 3,
      run(currentWorld) {
        slow.push(
          [...currentWorld.query([Counter], { changed: [Counter] })].map(([changed]) => changed)
        );
      }
    });

    schedule.runSync(world);
    schedule.runSync(world);
    schedule.runSync(world);

    expect(fast).toEqual([[entity], [entity], []]);
    expect(slow).toEqual([[entity]]);
  });

  test('retains component tombstones until independent readers advance', () => {
    const world = new World();
    world.registerComponent(Counter);
    const entity = world.spawn().insert(Counter, { value: 1 }).build();
    const first = world.createChangeReader({ from: 'current' });
    const second = world.createChangeReader({ from: 'current' });

    world.despawn(entity);

    const firstRemoved = world.withChangeReader(first, () => world.readRemoved(Counter));
    const secondRemoved = world.withChangeReader(second, () => world.readRemoved(Counter));

    expect(firstRemoved.map((entry) => entry.entity)).toEqual([entity]);
    expect(secondRemoved.map((entry) => entry.entity)).toEqual([entity]);
    expect(firstRemoved[0]?.component).toBe(Counter);
    expect(secondRemoved[0]?.tick).toBe(firstRemoved[0]?.tick);
  });
});
