import { performance } from 'node:perf_hooks';
import type { BenchmarkChecksum } from '../harness/types';
import { expectedDenseChecksum, initialPosition, initialVelocity } from '../scenarios/definitions';
import type { BenchmarkSubject, PreparedBenchmark } from './types';
import { unsupported } from './types';

export const RAW_SOA_SUBJECT: BenchmarkSubject = Object.freeze<BenchmarkSubject>({
  id: 'raw-soa',
  version: 'javascript-float32array-soa',
  prepare(scenario, input) {
    if (!['dense-read', 'dense-update', 'selective-query'].includes(scenario.id)) {
      return unsupported(`raw SoA does not provide ECS ${scenario.id.replaceAll('-', ' ')} semantics`);
    }
    const setupStartedAt = performance.now();
    const x = new Float32Array(input.scale);
    const y = new Float32Array(input.scale);
    const vx = new Float32Array(input.scale);
    const vy = new Float32Array(input.scale);
    const selected = new Uint8Array(input.scale);
    const setupMs = performance.now() - setupStartedAt;
    const populationStartedAt = performance.now();
    for (let index = 0; index < input.scale; index++) {
      const position = initialPosition(index, input.seedOffset);
      const velocity = initialVelocity(index);
      x[index] = position.x;
      y[index] = position.y;
      vx[index] = velocity.x;
      vy[index] = velocity.y;
      selected[index] = index < input.matchCount ? 1 : 0;
    }
    const populationMs = performance.now() - populationStartedAt;
    const mode = scenario.id === 'dense-read' ? 'read' : scenario.id === 'dense-update' ? 'update' : 'selective';
    const prepared: PreparedBenchmark = {
      expectedChecksum: expectedDenseChecksum(input, mode),
      reset() {
        for (let index = 0; index < input.scale; index++) {
          const position = initialPosition(index, input.seedOffset);
          x[index] = position.x;
          y[index] = position.y;
        }
      },
      validate() {
        this.reset();
        return this.runIteration();
      },
      runIteration() {
        let count = 0;
        let value = 0;
        for (let index = 0; index < input.scale; index++) {
          if (mode === 'selective' && selected[index] === 0) continue;
          if (mode !== 'read') {
            x[index] = x[index]! + vx[index]!;
            y[index] = y[index]! + vy[index]!;
          }
          count++;
          value += x[index]! + y[index]! + (mode === 'read' ? vx[index]! + vy[index]! : 0);
        }
        return Object.freeze({ count, value }) as BenchmarkChecksum;
      },
      counters: () => Object.freeze({ rowsExamined: input.scale }),
      dispose() {}
    };
    prepared.reset();
    return {
      status: 'supported',
      prepared,
      preparation: Object.freeze({ setupMs, populationMs, queryPreparationMs: 0 })
    } as const;
  }
});
