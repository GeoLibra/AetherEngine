import { bench, expect } from 'vitest';
import {
  assertDynamicPluginReference,
  runDynamicPluginAether,
  runDynamicPluginReference
} from './dynamic-plugin-runtime/model';

const profile = process.env.AETHER_BENCH_PROFILE ?? 'smoke';
const pluginScales = profile === 'smoke' ? [1, 10] : [1, 10, 100];
const contributionScales = profile === 'nightly' ? [1, 10, 1_000] : [1, 10];

for (const plugins of pluginScales) {
  for (const contributionsPerPlugin of contributionScales) {
    bench(
      `updates ${plugins} plugins with ${contributionsPerPlugin} contributions each`,
      async () => {
        const input = { plugins, contributionsPerPlugin, pendingPerPlugin: 2 };
        const reference = runDynamicPluginReference(input);
        const result = await runDynamicPluginAether(input);
        assertDynamicPluginReference(result, input);
        expect(result).toEqual(reference);
      },
      { iterations: 1, warmupIterations: 0 }
    );
  }
}
