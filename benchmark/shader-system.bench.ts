import { bench, expect } from 'vitest';
import { createShaderBindingManifest } from '../src/shader';
import {
  InMemoryShaderSourceResolver,
  parseFluxShader,
  resolveShaderSource
} from '../src/shader/experimental/flux/frontend';
import { ShaderCompiler } from '../src/shader/experimental/flux/compiler';
import { runBindingLayoutScenario } from './shader-system/binding-layout-scenario';
import { runShaderGraphScenario } from './shader-system/shader-graph-scenario';
import { runModuleCompositionScenario } from './shader-system/module-composition-scenario';
import {
  BUILT_IN_WEBGL2_TRANSLATOR,
  STANDARD_LIT_SHADER_MODULE,
  STANDARD_LIT_LIST_WEBGL2_SHADER_MODULE
} from '../src';

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
    const result = await compiler.compile({
      revision: 1,
      source: { uri: 'asset://bench/main.flux', languageVersion: 1 },
      entries: ['main'],
      target: 'wgsl',
      variants: {},
      capabilities: []
    });
    expect(result.status).toBe('compiled');
  },
  { iterations: 1, warmupIterations: 0 }
);

for (const chainLength of [16, 64] as const) {
  bench(
    `lower and cache-hit ShaderGraph with ${chainLength} nodes`,
    async () => {
      const result = await runShaderGraphScenario({ chainLength, cacheHits: 8 });
      expect(result.nodeCount).toBe(chainLength);
      expect(result.reusedNodes).toBe(chainLength * 8);
      expect(result.sliceLowerOk).toBe(true);
      expect(result.checksum).not.toBe(0);
    },
    { iterations: 1, warmupIterations: 0 }
  );
}

for (const moduleCount of [16, 64] as const) {
  bench(
    `resolve, link and trace invalidation for ${moduleCount} shader modules`,
    async () => {
      const result = await runModuleCompositionScenario({
        moduleCount,
        linesPerModule: 20,
        topology: 'diamond'
      });
      expect(result.closureModuleCount).toBeGreaterThanOrEqual(moduleCount - 2);
      expect(result.compositeHash).toBeTruthy();
    },
    { iterations: 1, warmupIterations: 0 }
  );
}

bench(
  'translate built-in shaders to WebGL2 via router',
  () => {
    const v = BUILT_IN_WEBGL2_TRANSLATOR.translate({
      wgsl: STANDARD_LIT_SHADER_MODULE,
      stage: 'vertex',
      entryPoint: 'standardLitVertex',
      constants: {},
      capabilities: [],
      approvedExtensions: [],
      clipDepthMode: 'vertex-remap'
    });
    const f = BUILT_IN_WEBGL2_TRANSLATOR.translate({
      wgsl: STANDARD_LIT_LIST_WEBGL2_SHADER_MODULE,
      stage: 'fragment',
      entryPoint: 'standardLitFragment',
      constants: {},
      capabilities: [],
      approvedExtensions: [],
      clipDepthMode: 'vertex-remap'
    });
    expect(v.source).toBeTruthy();
    expect(f.source).toBeTruthy();
  },
  { iterations: 1, warmupIterations: 0 }
);
