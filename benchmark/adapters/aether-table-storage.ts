import { performance } from 'node:perf_hooks';
import { type Entity } from '../../src';
import { serializeComponent } from '../../src/ecs/component';
import { Table } from '../../src/ecs/storage';
import type { BenchmarkChecksum, ScenarioInput } from '../harness/types';
import { expectedDenseChecksum, initialPosition, initialVelocity } from '../scenarios/definitions';
import { BenchmarkPosition, BenchmarkVelocity } from '../scenarios/components';
import type { BenchmarkSubject, PreparedBenchmark, PrepareResult } from './types';
import { unsupported } from './types';

export const AETHER_TABLE_STORAGE_SUBJECT: BenchmarkSubject = Object.freeze<BenchmarkSubject>({
  id: 'aether-table-storage',
  version: 'workspace-diagnostic',
  prepare(scenario, input) {
    if (scenario.id !== 'dense-update') {
      return unsupported('Aether direct Table storage is a dense-update diagnostic lane only.');
    }
    return prepareTableStorage(input);
  }
});

function prepareTableStorage(input: ScenarioInput): PrepareResult {
  const setupStartedAt = performance.now();
  const table = new Table([BenchmarkPosition, BenchmarkVelocity]);
  const setupMs = performance.now() - setupStartedAt;
  const populationStartedAt = performance.now();
  for (let index = 0; index < input.scale; index++) {
    table.insert(
      (index + 1) as Entity,
      new Map([
        [
          BenchmarkPosition.id,
          serializeComponent(BenchmarkPosition, initialPosition(index, input.seedOffset))
        ],
        [BenchmarkVelocity.id, serializeComponent(BenchmarkVelocity, initialVelocity(index))]
      ])
    );
  }
  const populationMs = performance.now() - populationStartedAt;
  const reset = (): void => {
    for (let index = 0; index < table.length; index++) {
      table.writeComponent(
        BenchmarkPosition,
        index,
        serializeComponent(BenchmarkPosition, initialPosition(index, input.seedOffset))
      );
    }
  };
  const runIteration = (): BenchmarkChecksum => {
    let value = 0;
    for (let index = 0; index < table.length; index++) {
      const positionStorage = table.getComponentStorage(BenchmarkPosition.id, index);
      const velocityStorage = table.getComponentStorage(BenchmarkVelocity.id, index);
      const position = new DataView(positionStorage.buffer);
      const velocity = new DataView(velocityStorage.buffer);
      const positionBase = positionStorage.row * BenchmarkPosition.size;
      const velocityBase = velocityStorage.row * BenchmarkVelocity.size;
      const x = position.getFloat32(positionBase, true) + velocity.getFloat32(velocityBase, true);
      const y =
        position.getFloat32(positionBase + 4, true) + velocity.getFloat32(velocityBase + 4, true);
      position.setFloat32(positionBase, x, true);
      position.setFloat32(positionBase + 4, y, true);
      value += x + y;
    }
    return Object.freeze({ count: table.length, value });
  };
  const prepared: PreparedBenchmark = {
    expectedChecksum: expectedDenseChecksum(input, 'update'),
    reset,
    validate: runIteration,
    runIteration,
    counters: () => Object.freeze({ rowsExamined: table.length, chunks: table.chunkCount }),
    dispose() {}
  };
  return {
    status: 'supported',
    prepared,
    preparation: Object.freeze({ setupMs, populationMs, queryPreparationMs: 0 })
  };
}
