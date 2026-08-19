import { describe, expect, test } from 'vitest';
import { CommandBuffer, World, defineComponent, type MonotonicClock } from '../../src';

class ManualClock implements MonotonicClock {
  private value = 0;
  now(): number {
    return this.value;
  }
  advance(milliseconds: number): void {
    this.value += milliseconds;
  }
}

const Counter = defineComponent<{ value: number }>({
  id: 'test.metrics-counter',
  version: 1,
  name: 'MetricsCounter',
  fields: [{ id: 'value', name: 'value', type: 'u32' }]
});

describe('World metrics', () => {
  test('composes immutable counters from their owning ECS modules', () => {
    const clock = new ManualClock();
    const world = new World(undefined, { clock });
    world.registerComponent(Counter);
    world.addObserver({
      id: 'test.metrics-observer',
      event: 'entity-despawned',
      run: () => clock.advance(3)
    });
    const entity = world.spawn().insert(Counter, { value: 1 }).build();
    expect([...world.createQueryState([Counter] as const)]).toHaveLength(1);
    world.despawn(entity);
    const commands = new CommandBuffer();
    commands.spawn();
    commands.apply(world, 'metrics-test');

    const metrics = world.metrics();
    expect(metrics).toMatchObject({
      aliveEntities: 1,
      tables: 1,
      liveRows: 0,
      relationEdges: 0,
      lastCommandBatchSize: 1,
      observerTimeMs: 3,
      rowFilters: 1
    });
    expect(metrics.chunks).toBeGreaterThanOrEqual(1);
    expect(metrics.allocatedRows).toBeGreaterThanOrEqual(1);
    expect(metrics.removedLogAge).toBeGreaterThanOrEqual(0);
    expect(Object.isFrozen(metrics)).toBe(true);
  });
});
