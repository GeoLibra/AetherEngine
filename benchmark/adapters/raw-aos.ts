import { performance } from 'node:perf_hooks';
import type { BenchmarkChecksum } from '../harness/types';
import { expectedDenseChecksum, initialPosition, initialVelocity } from '../scenarios/definitions';
import type { BenchmarkSubject, PreparedBenchmark } from './types';
import { unsupported } from './types';

interface Row {
  x: number;
  y: number;
  vx: number;
  vy: number;
  selected: boolean;
}

export const RAW_AOS_SUBJECT: BenchmarkSubject = Object.freeze<BenchmarkSubject>({
  id: 'raw-aos',
  version: 'javascript-object-array',
  prepare(scenario, input) {
    if (!['dense-read', 'dense-update', 'selective-query'].includes(scenario.id)) {
      return unsupported(rawUnsupportedReason(scenario.id));
    }
    const setupStartedAt = performance.now();
    const rows: Row[] = new Array<Row>(input.scale);
    const setupMs = performance.now() - setupStartedAt;
    const populationStartedAt = performance.now();
    for (let index = 0; index < input.scale; index++) {
      const position = initialPosition(index, input.seedOffset);
      const velocity = initialVelocity(index);
      rows[index] = {
        x: position.x,
        y: position.y,
        vx: velocity.x,
        vy: velocity.y,
        selected: index < input.matchCount
      };
    }
    const populationMs = performance.now() - populationStartedAt;
    const mode =
      scenario.id === 'dense-read'
        ? 'read'
        : scenario.id === 'dense-update'
          ? 'update'
          : 'selective';
    const prepared: PreparedBenchmark = {
      expectedChecksum: expectedDenseChecksum(input, mode),
      reset() {
        for (let index = 0; index < rows.length; index++) {
          const position = initialPosition(index, input.seedOffset);
          rows[index]!.x = position.x;
          rows[index]!.y = position.y;
        }
      },
      validate() {
        this.reset();
        return this.runIteration();
      },
      runIteration() {
        let count = 0;
        let value = 0;
        for (const row of rows) {
          if (mode === 'selective' && !row.selected) continue;
          if (mode !== 'read') {
            row.x += row.vx;
            row.y += row.vy;
          }
          count++;
          value += row.x + row.y + (mode === 'read' ? row.vx + row.vy : 0);
        }
        return checksum(count, value);
      },
      counters: () => Object.freeze({ rowsExamined: rows.length }),
      dispose() {}
    };
    return {
      status: 'supported',
      prepared,
      preparation: Object.freeze({ setupMs, populationMs, queryPreparationMs: 0 })
    } as const;
  }
});

function rawUnsupportedReason(id: string): string {
  return `raw AoS does not provide ECS ${id.replaceAll('-', ' ')} semantics`;
}

function checksum(count: number, value: number): BenchmarkChecksum {
  return Object.freeze({ count, value });
}
