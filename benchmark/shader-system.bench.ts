import { bench, expect } from 'vitest';
import { createShaderBindingManifest } from '../src/shader';
import {
  InMemoryShaderSourceResolver,
  parseFluxShader,
  resolveShaderSource
} from '../src/shader/experimental/flux/frontend';
import { ShaderCompiler } from '../src/shader/experimental/flux/compiler';
import { runBindingLayoutScenario } from './shader-system/binding-layout-scenario';

const structFields = Array.from({ length: 64 }, (_, index) => `field${index}: vec4<f32>`).join(
  ', '
);
const source = `struct Parameters { ${structFields}, };\n@group(0) @binding(0) var<uniform> parameters: Parameters;\n@vertex fn main() {}`;
const resolver = new InMemoryShaderSourceResolver({ 'asset://bench/main.flux': source });

bench(
  'resolve, parse and reflect a 64-field shader',
  async () => {
    const closure = await resolveShaderSource(
      { uri: 'asset://bench/main.flux', languageVersion: 1 },
      resolver
    );
    const parsed = parseFluxShader(closure);
    if (!parsed.ir) throw new Error('benchmark parse failed');
    const manifest = createShaderBindingManifest(parsed.ir, 1);
    expect(manifest.buffers[0]?.fields).toHaveLength(64);
  },
  { iterations: 1, warmupIterations: 0 }
);

for (const [groups, bindingsPerGroup] of [1, 4, 8].flatMap((groups) =>
  [4, 16, 64].map((bindingsPerGroup) => [groups, bindingsPerGroup] as const)
)) {
  bench(
    `compile, lower and cache ${groups}x${bindingsPerGroup} binding layouts`,
    () => {
      const result = runBindingLayoutScenario({ groups, bindingsPerGroup, cacheHits: 16 });
      expect(result.reorderEquivalent).toBe(true);
      expect(result.synchronousRhiCreates).toBe(0);
      expect(result.unsupportedCount).toBe(1);
    },
    { iterations: 1, warmupIterations: 0 }
  );
}

bench(
  'compile and hit the content-addressed cache',
  async () => {
    const compiler = new ShaderCompiler({
      resolver,
      validators: { wgsl: { validate: async () => [] } },
      versions: { compiler: 1, ir: 1, abi: 1, backend: 1 }
    });
    const request = {
      revision: 1,
      source: { uri: 'asset://bench/main.flux', languageVersion: 1 },
      entries: ['main'],
      target: 'wgsl' as const,
      variants: {},
      capabilities: []
    };
    const first = await compiler.compile(request);
    const second = await compiler.compile({ ...request, revision: 2 });
    expect(first.status).toBe('compiled');
    expect(second.status).toBe('cached');
  },
  { iterations: 1, warmupIterations: 0 }
);
