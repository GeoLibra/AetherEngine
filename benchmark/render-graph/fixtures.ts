import type {
  RenderGraphAccess,
  RenderGraphPassWorkload,
  RenderGraphWorkload,
  RenderGraphWorkloadOptions
} from './types';

const DEFAULT_RANDOM_STATE = 0x9e3779b9;

export function createRenderGraphWorkload(
  options: RenderGraphWorkloadOptions
): RenderGraphWorkload {
  assertOptions(options);
  const normalizedOptions = Object.freeze({ ...options });
  const accessesPerPass = Math.floor(options.resourceCount * options.accessDensity);
  let state = options.seed >>> 0 || DEFAULT_RANDOM_STATE;
  const passes: RenderGraphPassWorkload[] = [];

  for (let registrationIndex = 0; registrationIndex < options.passCount; registrationIndex += 1) {
    const resourceOrder = shuffledResourceIndices(options.resourceCount, () => {
      state = nextRandom(state);
      return state;
    });
    const accesses: RenderGraphAccess[] = [];
    for (let accessIndex = 0; accessIndex < accessesPerPass; accessIndex += 1) {
      const resourceIndex = resourceOrder[accessIndex];
      if (resourceIndex === undefined)
        throw new Error('RenderGraph fixture resource order is incomplete.');
      state = nextRandom(state);
      accesses.push(
        Object.freeze({
          resourceIndex,
          mode: (state & 1) === 0 ? 'read' : 'write'
        })
      );
    }
    passes.push(Object.freeze({ registrationIndex, accesses: Object.freeze(accesses) }));
  }

  return Object.freeze({
    version: 1,
    options: normalizedOptions,
    accessesPerPass,
    passes: Object.freeze(passes)
  });
}

function assertOptions(options: RenderGraphWorkloadOptions): void {
  if (!Number.isInteger(options.seed))
    throw new Error('RenderGraph workload seed must be an integer.');
  if (!Number.isInteger(options.passCount) || options.passCount < 0) {
    throw new Error('RenderGraph workload passCount must be a non-negative integer.');
  }
  if (!Number.isInteger(options.resourceCount) || options.resourceCount < 0) {
    throw new Error('RenderGraph workload resourceCount must be a non-negative integer.');
  }
  if (
    !Number.isFinite(options.accessDensity) ||
    options.accessDensity < 0 ||
    options.accessDensity > 1
  ) {
    throw new Error('RenderGraph workload accessDensity must be between zero and one.');
  }
}

function shuffledResourceIndices(resourceCount: number, next: () => number): number[] {
  const values = Array.from({ length: resourceCount }, (_, index) => index);
  for (let index = values.length - 1; index > 0; index -= 1) {
    const target = next() % (index + 1);
    const current = values[index];
    values[index] = values[target]!;
    values[target] = current!;
  }
  return values;
}

function nextRandom(state: number): number {
  let value = state;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return value >>> 0;
}
