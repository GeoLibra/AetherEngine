import type {
  BenchmarkProfile,
  BenchmarkProfileName
} from './harness/types';

const PROFILES: Readonly<Record<BenchmarkProfileName, BenchmarkProfile>> = Object.freeze({
  smoke: Object.freeze({ name: 'smoke', warmupCount: 1, sampleCount: 3, rounds: 1 }),
  standard: Object.freeze({ name: 'standard', warmupCount: 5, sampleCount: 30, rounds: 2 }),
  nightly: Object.freeze({ name: 'nightly', warmupCount: 10, sampleCount: 100, rounds: 5 })
});

export function resolveProfile(name: string): BenchmarkProfile {
  if (!Object.hasOwn(PROFILES, name)) {
    throw new Error(`Unknown benchmark profile "${name}". Expected smoke, standard, or nightly.`);
  }
  return PROFILES[name as BenchmarkProfileName];
}
