import { bench, expect } from 'vitest';
import {
  assertDynamicPluginReference,
  runDynamicPluginReference
} from './dynamic-plugin-runtime/model';

const profile = process.env.AETHER_BENCH_PROFILE ?? 'smoke';
const pluginScales = profile === 'smoke' ? [1, 10] : [1, 10, 100];
const contributionScales = profile === 'nightly' ? [1, 10, 1_000] : [1, 10];

for (const plugins of pluginScales) {
  for (const contributionsPerPlugin of contributionScales) {
    bench(
      `updates ${plugins} plugins with ${contributionsPerPlugin} contributions each`,
      () => {
        const input = { plugins, contributionsPerPlugin, pendingPerPlugin: 2 };
        const result = runDynamicPluginReference(input);
        assertDynamicPluginReference(result, input);
        expect(result.snapshotCopies).toBe(plugins * 2);
      },
      { iterations: 1, warmupIterations: 0 }
    );
  }
}
