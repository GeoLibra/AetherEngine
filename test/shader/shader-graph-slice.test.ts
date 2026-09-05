import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { lowerVerticalSliceGraph, type ShaderGraph } from '../../src/shader/experimental/graph';
import { loadCookedShaderModule } from '../../src/shader/pipeline';
import { NativeWgslCooker } from '../../tools/shader-cooker/native-wgsl-cooker';

describe('ShaderGraph minimal vertical slice', () => {
  const fixtureDir = join(process.cwd(), 'test/fixtures/shader-graph');
  const wgslPath = join(fixtureDir, 'slice.wgsl');
  const metaPath = join(fixtureDir, 'slice.wgsl.meta.json');

  beforeAll(() => {
    if (!existsSync(fixtureDir)) {
      mkdirSync(fixtureDir, { recursive: true });
    }
  });

  afterAll(() => {
    if (existsSync(wgslPath)) unlinkSync(wgslPath);
    if (existsSync(metaPath)) unlinkSync(metaPath);
  });

  const minimalSliceGraph: ShaderGraph = {
    revision: 1,
    nodes: [
      {
        id: 'position',
        kind: 'vertexAttribute',
        outputType: 'vec3f',
        location: 0
      },
      {
        id: 'tint',
        kind: 'parameter',
        outputType: 'vec4f',
        group: 0,
        binding: 0
      },
      {
        id: 'baseTexture',
        kind: 'parameter',
        outputType: 'texture_2d<f32>',
        group: 1,
        binding: 0
      },
      {
        id: 'baseSampler',
        kind: 'parameter',
        outputType: 'sampler',
        group: 1,
        binding: 1
      },
      {
        id: 'uv',
        kind: 'constant',
        outputType: 'vec2f',
        value: [0.5, 0.5]
      },
      {
        id: 'sampledColor',
        kind: 'textureSample',
        inputs: {
          texture: 'baseTexture',
          sampler: 'baseSampler',
          uv: 'uv'
        }
      },
      {
        id: 'finalColor',
        kind: 'multiply',
        inputs: {
          left: 'sampledColor',
          right: 'tint'
        }
      },
      {
        id: 'outColor',
        kind: 'fragmentOutput',
        inputs: {
          color: 'finalColor'
        }
      }
    ],
    outputs: {
      vertex: 'position',
      fragment: 'outColor'
    }
  };

  test('lowers graph to typed IR and standard WGSL with metadata', () => {
    const result = lowerVerticalSliceGraph(minimalSliceGraph);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.ir.vertexInputs).toHaveLength(1);
      expect(result.ir.uniforms).toHaveLength(1);
      expect(result.ir.textures).toHaveLength(1);
      expect(result.ir.samplers).toHaveLength(1);

      expect(result.wgsl).toContain(
        '@group(0) @binding(0) var<uniform> materialParams: MaterialParams;'
      );
      expect(result.wgsl).toContain('@group(1) @binding(0) var baseTexture: texture_2d<f32>;');
      expect(result.wgsl).toContain('@group(1) @binding(1) var baseSampler: sampler;');
      expect(result.wgsl).toContain('textureSample(baseTexture, baseSampler, uv)');
      expect(result.wgsl).toContain('@vertex');
      expect(result.wgsl).toContain('@fragment');

      const meta = JSON.parse(result.metadataJson);
      expect(meta.schemaVersion).toBe(1);
      expect(meta.entryPoints).toHaveLength(2);
    }
  });

  test('end-to-end: lowers graph, cooks with Native Naga cooker, and loads into runtime', async () => {
    const lowered = lowerVerticalSliceGraph(minimalSliceGraph);
    expect(lowered.ok).toBe(true);
    if (!lowered.ok) return;

    writeFileSync(wgslPath, lowered.wgsl, 'utf8');
    writeFileSync(metaPath, lowered.metadataJson, 'utf8');

    const cooker = new NativeWgslCooker();
    const artifact = await cooker.cook({
      sourcePath: wgslPath,
      sourceUri: 'asset://fixtures/shader-graph/slice.wgsl',
      metadataPath: metaPath
    });

    expect(artifact.schemaVersion).toBe(2);
    expect(artifact.bindings.length).toBeGreaterThanOrEqual(3);
    expect(artifact.modules.wgsl).toBe(lowered.wgsl);
    expect(artifact.modules.glslEs300['fragment:fragmentMain']).toBeDefined();
    expect(artifact.modules.glslEs300['vertex:vertexMain']).toBeDefined();

    // Verify runtime module loading for both targets
    const wgslModule = loadCookedShaderModule(artifact, {
      target: 'wgsl',
      entry: 'fragmentMain',
      stage: 'fragment'
    });
    expect(wgslModule.target).toBe('wgsl');
    expect(wgslModule.source).toContain('fragmentMain');

    const glslModule = loadCookedShaderModule(artifact, {
      target: 'glsl300es',
      entry: 'fragmentMain',
      stage: 'fragment'
    });
    expect(glslModule.target).toBe('glsl300es');
    expect(glslModule.source).toContain('main');
  });

  test('rejects unknown node types not supported in vertical slice', () => {
    const invalidGraph: ShaderGraph = {
      revision: 1,
      nodes: [{ id: 'custom', kind: 'customFunctionNode' }],
      outputs: { fragment: 'custom' }
    };
    const result = lowerVerticalSliceGraph(invalidGraph);
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'GRAPH_UNKNOWN_NODE_TYPE' }]
    });
  });

  test('rejects type mismatch in arithmetic nodes', () => {
    const mismatchGraph: ShaderGraph = {
      revision: 1,
      nodes: [
        { id: 'v2', kind: 'constant', outputType: 'vec2f', value: [1, 2] },
        { id: 'v3', kind: 'constant', outputType: 'vec3f', value: [1, 2, 3] },
        { id: 'sum', kind: 'add', inputs: { left: 'v2', right: 'v3' } }
      ],
      outputs: { fragment: 'sum' }
    };
    const result = lowerVerticalSliceGraph(mismatchGraph);
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'GRAPH_TYPE_MISMATCH' }]
    });
  });
});
