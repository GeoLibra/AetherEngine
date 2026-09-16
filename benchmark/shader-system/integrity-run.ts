import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { summarize } from '../harness/statistics';
import {
  BUILT_IN_WEBGL2_TRANSLATOR,
  LIGHT_LIST_WEBGL2_SHADER_ARTIFACT,
  LIGHT_LIST_WEBGL2_SHADER_MODULE,
  POST_COLOR_SHADER_ARTIFACT,
  POST_COLOR_SHADER_MODULE,
  STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT,
  STANDARD_LIT_LIST_WEBGL2_SHADER_MODULE,
  STANDARD_LIT_SHADER_ARTIFACT,
  STANDARD_LIT_SHADER_MODULE,
  createCookedArtifactWebGL2Translator,
  createShaderBindingManifest
} from '../../src';
import {
  InMemoryShaderSourceResolver,
  parseFluxShader,
  resolveShaderSource
} from '../../src/shader/experimental/flux/frontend';
import { ShaderCompiler } from '../../src/shader/experimental/flux/compiler';
import { runBindingLayoutScenario } from './binding-layout-scenario';
import { runShaderGraphScenario } from './shader-graph-scenario';
import { runModuleCompositionScenario } from './module-composition-scenario';

const profile = process.argv.at(-1);
if (profile !== 'smoke' && profile !== 'standard' && profile !== 'nightly') {
  throw new Error(`Unknown shader-system integrity profile: ${profile ?? '<missing>'}`);
}

const sampleCounts = { smoke: 5, standard: 30, nightly: 60 } as const;
const warmupCounts = { smoke: 2, standard: 10, nightly: 20 } as const;
const samples = sampleCounts[profile];
const warmups = warmupCounts[profile];
const totalRounds = warmups + samples;

// 1. Binding Layout ABI Compilation & Cache Hit Scenarios
const bindingLayoutConfigs = [
  { groups: 1, bindingsPerGroup: 4 },
  { groups: 4, bindingsPerGroup: 16 },
  { groups: 8, bindingsPerGroup: 64 }
] as const;

const bindingLayoutResults = bindingLayoutConfigs.map(({ groups, bindingsPerGroup }) => {
  const rawSamplesMs: number[] = [];
  for (let round = 0; round < totalRounds; round++) {
    const start = performance.now();
    const result = runBindingLayoutScenario({ groups, bindingsPerGroup, cacheHits: 16 });
    const duration = performance.now() - start;
    if (
      !result.reorderEquivalent ||
      result.synchronousRhiCreates !== 0 ||
      result.unsupportedCount !== 1
    ) {
      throw new Error(`Binding layout structural oracle failed for ${groups}x${bindingsPerGroup}.`);
    }
    if (round >= warmups) rawSamplesMs.push(duration);
  }
  return Object.freeze({
    groups,
    bindingsPerGroup,
    rawSamplesMs,
    summary: summarize(rawSamplesMs)
  });
});

// 2. ShaderGraph Lowering & Merkle Cache Reuse Scenarios
const chainLengths = [16, 64] as const;
const shaderGraphResults: Array<{
  chainLength: number;
  rawSamplesMs: number[];
  summary: ReturnType<typeof summarize>;
}> = [];

for (const chainLength of chainLengths) {
  const rawSamplesMs: number[] = [];
  for (let round = 0; round < totalRounds; round++) {
    const start = performance.now();
    const result = await runShaderGraphScenario({ chainLength, cacheHits: 8 });
    const duration = performance.now() - start;
    if (
      result.nodeCount !== chainLength ||
      result.reusedNodes !== chainLength * 8 ||
      !result.sliceLowerOk
    ) {
      throw new Error(`ShaderGraph structural oracle failed for chain length ${chainLength}.`);
    }
    if (round >= warmups) rawSamplesMs.push(duration);
  }
  shaderGraphResults.push({
    chainLength,
    rawSamplesMs,
    summary: summarize(rawSamplesMs)
  });
}

// 3. Built-in Shader WebGL2 Router Translation Scenarios
const builtInTranslations = [
  {
    name: 'standard-lit-vertex',
    wgsl: STANDARD_LIT_SHADER_MODULE,
    stage: 'vertex' as const,
    entryPoint: 'standardLitVertex',
    expectedFingerprint: 'standard-lit-v2'
  },
  {
    name: 'post-color-fragment',
    wgsl: POST_COLOR_SHADER_MODULE,
    stage: 'fragment' as const,
    entryPoint: 'postColorFragment',
    expectedFingerprint: 'post-color-v1'
  },
  {
    name: 'light-list-fragment',
    wgsl: LIGHT_LIST_WEBGL2_SHADER_MODULE,
    stage: 'fragment' as const,
    entryPoint: 'lightListFragment',
    expectedFingerprint: 'light-list-webgl-v2'
  },
  {
    name: 'standard-lit-list-fragment',
    wgsl: STANDARD_LIT_LIST_WEBGL2_SHADER_MODULE,
    stage: 'fragment' as const,
    entryPoint: 'standardLitFragment',
    expectedFingerprint: 'standard-lit-list-v3'
  }
] as const;

const builtInTranslationResults = builtInTranslations.map((item) => {
  const rawSamplesMs: number[] = [];
  for (let round = 0; round < totalRounds; round++) {
    const start = performance.now();
    const translated = BUILT_IN_WEBGL2_TRANSLATOR.translate({
      wgsl: item.wgsl,
      stage: item.stage,
      entryPoint: item.entryPoint,
      constants: {},
      capabilities: [],
      approvedExtensions: [],
      clipDepthMode: 'vertex-remap'
    });
    const duration = performance.now() - start;
    if (!translated.source || translated.targetAbiFingerprint !== item.expectedFingerprint) {
      throw new Error(`Built-in shader translation oracle failed for ${item.name}.`);
    }
    if (round >= warmups) rawSamplesMs.push(duration);
  }
  return Object.freeze({
    name: item.name,
    targetAbiFingerprint: item.expectedFingerprint,
    rawSamplesMs,
    summary: summarize(rawSamplesMs)
  });
});

// 4. Cooked Artifact Translation Scenarios
const cookedArtifacts = [
  {
    name: 'standard-lit',
    artifact: STANDARD_LIT_SHADER_ARTIFACT,
    module: STANDARD_LIT_SHADER_MODULE,
    entryPoint: 'standardLitVertex',
    stage: 'vertex' as const
  },
  {
    name: 'post-color',
    artifact: POST_COLOR_SHADER_ARTIFACT,
    module: POST_COLOR_SHADER_MODULE,
    entryPoint: 'postColorFragment',
    stage: 'fragment' as const
  },
  {
    name: 'light-list',
    artifact: LIGHT_LIST_WEBGL2_SHADER_ARTIFACT,
    module: LIGHT_LIST_WEBGL2_SHADER_MODULE,
    entryPoint: 'lightListFragment',
    stage: 'fragment' as const
  },
  {
    name: 'standard-lit-list',
    artifact: STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT,
    module: STANDARD_LIT_LIST_WEBGL2_SHADER_MODULE,
    entryPoint: 'standardLitFragment',
    stage: 'fragment' as const
  }
] as const;

const cookedArtifactResults = cookedArtifacts.map((item) => {
  const translator = createCookedArtifactWebGL2Translator({
    translatorId: `bench.${item.name}`,
    version: 1,
    artifact: item.artifact,
    supportedEntryPoints: [item.entryPoint]
  });
  const rawSamplesMs: number[] = [];
  for (let round = 0; round < totalRounds; round++) {
    const start = performance.now();
    const translated = translator.translate({
      wgsl: item.module,
      stage: item.stage,
      entryPoint: item.entryPoint,
      constants: {},
      capabilities: [],
      approvedExtensions: [],
      clipDepthMode: 'vertex-remap'
    });
    const duration = performance.now() - start;
    if (!translated.source || translated.source.length === 0) {
      throw new Error(`Cooked artifact translation oracle failed for ${item.name}.`);
    }
    if (round >= warmups) rawSamplesMs.push(duration);
  }
  return Object.freeze({
    name: item.name,
    rawSamplesMs,
    summary: summarize(rawSamplesMs)
  });
});

// 5. Flux Frontend Parse, Reflection & Cache Scenarios
const structFields = Array.from({ length: 64 }, (_, index) => `field${index}: vec4<f32>`).join(
  ', '
);
const fluxSource = `struct Parameters { ${structFields}, };\n@group(0) @binding(0) var<uniform> parameters: Parameters;\n@vertex fn main() {}`;
const fluxResolver = new InMemoryShaderSourceResolver({ 'asset://bench/main.flux': fluxSource });

const fluxParseSamplesMs: number[] = [];
for (let round = 0; round < totalRounds; round++) {
  const start = performance.now();
  const closure = await resolveShaderSource(
    { uri: 'asset://bench/main.flux', languageVersion: 1 },
    fluxResolver
  );
  const parsed = parseFluxShader(closure);
  if (!parsed.ir) throw new Error('Flux parse oracle failed');
  const manifest = createShaderBindingManifest(parsed.ir, 1);
  const duration = performance.now() - start;
  if (manifest.buffers[0]?.fields.length !== 64) {
    throw new Error('Flux manifest reflection oracle failed.');
  }
  if (round >= warmups) fluxParseSamplesMs.push(duration);
}

const compiler = new ShaderCompiler({
  resolver: fluxResolver,
  validators: { wgsl: { validate: async () => [] } },
  versions: { compiler: 1, ir: 1, abi: 1, backend: 1 }
});
const compileRequest = {
  revision: 1,
  source: { uri: 'asset://bench/main.flux', languageVersion: 1 },
  entries: ['main'],
  target: 'wgsl' as const,
  variants: {},
  capabilities: []
};
await compiler.compile(compileRequest);

const fluxCacheSamplesMs: number[] = [];
for (let round = 0; round < totalRounds; round++) {
  const start = performance.now();
  const cached = await compiler.compile({ ...compileRequest, revision: 2 + round });
  const duration = performance.now() - start;
  if (cached.status !== 'cached') throw new Error('Flux compiler cache oracle failed.');
  if (round >= warmups) fluxCacheSamplesMs.push(duration);
}

// 6. Shader Module Composition & Invalidation Scenarios
const moduleCompositionConfigs = [
  { moduleCount: 16, topology: 'diamond' as const },
  { moduleCount: 64, topology: 'diamond' as const },
  { moduleCount: 16, topology: 'chain' as const }
] as const;

const moduleCompositionResults: Array<{
  moduleCount: number;
  topology: string;
  rawSamplesMs: number[];
  summary: ReturnType<typeof summarize>;
}> = [];

for (const config of moduleCompositionConfigs) {
  const rawSamplesMs: number[] = [];
  for (let round = 0; round < totalRounds; round++) {
    const start = performance.now();
    const result = await runModuleCompositionScenario(config);
    const duration = performance.now() - start;
    if (
      result.closureModuleCount < config.moduleCount - 2 ||
      !result.compositeHash ||
      !result.compositeHashMatchesOracle ||
      result.sharedLeafAffectedRootsCount !== 2 ||
      result.rootLocalAffectedRootsCount !== 1 ||
      result.unrelatedAffectedRootsCount !== 0 ||
      !result.rebuildIsDeterministic
    ) {
      throw new Error(
        `Module composition structural oracle failed for ${config.moduleCount} ${config.topology}.`
      );
    }
    if (round >= warmups) rawSamplesMs.push(duration);
  }
  moduleCompositionResults.push(
    Object.freeze({
      moduleCount: config.moduleCount,
      topology: config.topology,
      rawSamplesMs,
      summary: summarize(rawSamplesMs)
    })
  );
}

const createdAt = new Date().toISOString();
const artifactDirectory = resolve('benchmark/artifacts/shader-system');
mkdirSync(artifactDirectory, { recursive: true });
const artifactPath = resolve(
  artifactDirectory,
  `shader-system-${profile}-${createdAt.replaceAll(':', '-')}.json`
);

const report = {
  schemaVersion: 1,
  profile,
  createdAt,
  environment: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch
  },
  repository: {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== ''
  },
  bindingLayoutResults,
  shaderGraphResults,
  builtInTranslationResults,
  cookedArtifactResults,
  moduleCompositionResults,
  fluxFrontendResults: {
    reflection: {
      rawSamplesMs: fluxParseSamplesMs,
      summary: summarize(fluxParseSamplesMs)
    },
    cacheHit: {
      rawSamplesMs: fluxCacheSamplesMs,
      summary: summarize(fluxCacheSamplesMs)
    }
  }
};

writeFileSync(artifactPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(
  `Shader-system integrity: profile=${profile} bindingCases=${bindingLayoutResults.length} graphCases=${shaderGraphResults.length} builtInCases=${builtInTranslationResults.length} cookedCases=${cookedArtifactResults.length} moduleCases=${moduleCompositionResults.length}\nArtifact: ${artifactPath}`
);
