import { describe, expect, it } from 'vitest';
import {
  assertDynamicPluginReference,
  runDynamicPluginReference
} from '../../benchmark/dynamic-plugin-runtime/model';
import { BENCHMARK_MANIFEST } from '../../benchmark/framework/manifest';

describe('dynamic plugin runtime benchmark contract', () => {
  it('routes the design and source paths to a dedicated suite', () => {
    const suite = BENCHMARK_MANIFEST.suites.find((entry) => entry.id === 'dynamic-plugin-runtime');

    expect(suite?.domainIds).toEqual(['runtime']);
    expect(suite?.pathPrefixes).toContain(
      'engine/design/v2/02-runtime/04-dynamic-plugin-runtime.md'
    );
    expect(suite?.pathPrefixes).toContain('src/dynamic-plugins/');
  });

  it('preserves last-good and reverse cleanup in the reference oracle', () => {
    const input = {
      plugins: 10,
      contributionsPerPlugin: 10,
      pendingPerPlugin: 2
    } as const;
    const result = runDynamicPluginReference(input);

    expect(() => assertDynamicPluginReference(result, input)).not.toThrow();
    expect(result.currentVersions.every((version) => version === 2)).toBe(true);
    expect(result.reverseCleanupViolations).toBe(0);
    expect(result.staleAccepted).toBe(0);
  });
});
