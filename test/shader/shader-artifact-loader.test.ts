import { describe, expect, test } from 'vitest';
import {
  loadCookedShaderModule,
  type CookedShaderModuleSelection
} from '../../src/shader/pipeline/artifact-loader';
import type { CookedShaderRuntimeArtifact } from '../../src/shader/types';

const sampleBinding = Object.freeze({
  group: 0,
  binding: 0,
  name: 'camera',
  kind: 'uniform-buffer',
  addressSpace: 'uniform',
  access: 'read',
  typeName: 'CameraUniforms'
});

const sampleArtifact: CookedShaderRuntimeArtifact = Object.freeze({
  schemaVersion: 1 as const,
  shaderManifestSchemaVersion: 1 as const,
  shaderModuleSchemaVersion: 1 as const,
  sourceKind: 'wgsl' as const,
  toolchain: Object.freeze({
    cookerId: 'aether-native-wgsl-cooker',
    cookerVersion: '0.0.0',
    nagaVersion: '30.0.0'
  }),
  source: Object.freeze({
    sourceUri: 'asset://shaders/test.wgsl',
    contentHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    byteLength: 120
  }),
  entryPoints: Object.freeze([
    Object.freeze({
      name: 'vertexMain',
      stage: 'vertex' as const,
      bindings: Object.freeze([sampleBinding])
    }),
    Object.freeze({
      name: 'fragmentMain',
      stage: 'fragment' as const,
      bindings: Object.freeze([])
    }),
    Object.freeze({
      name: 'computeMain',
      stage: 'compute' as const,
      bindings: Object.freeze([])
    })
  ]),
  bindings: Object.freeze([sampleBinding]),
  modules: Object.freeze({
    wgsl: '@vertex\nfn vertexMain() {}\n@fragment\nfn fragmentMain() {}\n@compute\nfn computeMain() {}',
    glslEs300: Object.freeze({
      'vertex:vertexMain': '#version 300 es\nvoid main() /* vs */ {}',
      'fragment:fragmentMain': '#version 300 es\nvoid main() /* fs */ {}'
    })
  })
});

describe('loadCookedShaderModule pure runtime loader', () => {
  test('selects WGSL module for WebGPU target with entry bindings and source provenance', () => {
    const selection: CookedShaderModuleSelection = {
      target: 'wgsl',
      entry: 'vertexMain'
    };

    const loaded = loadCookedShaderModule(sampleArtifact, selection);

    expect(loaded).toEqual({
      target: 'wgsl',
      entry: 'vertexMain',
      stage: 'vertex',
      source: sampleArtifact.modules.wgsl,
      bindings: [sampleBinding],
      sourceUri: 'asset://shaders/test.wgsl',
      contentHash: sampleArtifact.source.contentHash
    });
    expect(Object.isFrozen(loaded)).toBe(true);
    expect(Object.isFrozen(loaded.bindings)).toBe(true);
  });

  test('selects keyed GLSL ES 300 module for WebGL2 target with entry bindings', () => {
    const selection: CookedShaderModuleSelection = {
      target: 'glsl300es',
      entry: 'fragmentMain'
    };

    const loaded = loadCookedShaderModule(sampleArtifact, selection);

    expect(loaded).toEqual({
      target: 'glsl300es',
      entry: 'fragmentMain',
      stage: 'fragment',
      source: '#version 300 es\nvoid main() /* fs */ {}',
      bindings: [],
      sourceUri: 'asset://shaders/test.wgsl',
      contentHash: sampleArtifact.source.contentHash
    });
    expect(Object.isFrozen(loaded)).toBe(true);
  });

  test('fails with artifact-entry-missing when requested entry is not found', () => {
    expect(() =>
      loadCookedShaderModule(sampleArtifact, {
        target: 'wgsl',
        entry: 'nonExistentEntry'
      })
    ).toThrow(/artifact-entry-missing/i);
  });

  test('fails with artifact-target-unsupported when compute entry is requested on GLSL ES 300', () => {
    expect(() =>
      loadCookedShaderModule(sampleArtifact, {
        target: 'glsl300es',
        entry: 'computeMain'
      })
    ).toThrow(/artifact-target-unsupported/i);
  });

  test('fails with artifact-module-missing when GLSL ES 300 module key is missing in artifact', () => {
    const artifactMissingGlsl: CookedShaderRuntimeArtifact = {
      ...sampleArtifact,
      modules: {
        wgsl: sampleArtifact.modules.wgsl,
        glslEs300: {}
      }
    };

    expect(() =>
      loadCookedShaderModule(artifactMissingGlsl, {
        target: 'glsl300es',
        entry: 'vertexMain'
      })
    ).toThrow(/artifact-module-missing/i);
  });

  test('validates and copies input artifact before returning module', () => {
    const mutableArtifact = JSON.parse(JSON.stringify(sampleArtifact));
    const loaded = loadCookedShaderModule(mutableArtifact, {
      target: 'wgsl',
      entry: 'vertexMain'
    });

    expect(Object.isFrozen(loaded)).toBe(true);
  });
});
