import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

const cargo = process.env.CARGO ?? 'cargo';
const pinnedCargo = spawnSync(cargo, ['+1.95.0', '--version'], { encoding: 'utf8' });
const nativeCorpus = pinnedCargo.status === 0 ? describe : describe.skip;
const installExpectation = 'install with `rustup toolchain install 1.95.0`';
const manifest = 'tools/naga-shader-validator/Cargo.toml';

function cook(fixture: string, sourceUri: string) {
  return spawnSync(
    cargo,
    [
      '+1.95.0',
      'run',
      '--quiet',
      '--manifest-path',
      manifest,
      '--',
      'cook',
      `tools/naga-shader-validator/corpus/${fixture}`,
      '--source-uri',
      sourceUri
    ],
    { encoding: 'utf8' }
  );
}

nativeCorpus(`native WGSL cooker corpus (${installExpectation} when skipped)`, () => {
  test('cooks reflected WGSL into the versioned protocol and both graphics backends', () => {
    const sourceUri = 'asset://shader/bound-resources.wgsl';
    const result = cook('bound-resources.wgsl', sourceUri);

    const sceneBinding = {
      group: 0,
      binding: 0,
      name: 'scene',
      kind: 'uniform-buffer',
      addressSpace: 'uniform',
      access: 'read',
      typeName: 'SceneUniforms'
    };
    const textureBinding = {
      group: 1,
      binding: 0,
      name: 'colorTexture',
      kind: 'texture',
      addressSpace: 'handle',
      access: 'read',
      typeName: 'texture_2d<f32>'
    };
    const samplerBinding = {
      group: 1,
      binding: 1,
      name: 'colorSampler',
      kind: 'sampler',
      addressSpace: 'handle',
      access: 'read',
      typeName: 'sampler'
    };

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const artifact = JSON.parse(result.stdout);
    expect(artifact).toMatchObject({
      schemaVersion: 2,
      shaderManifestSchemaVersion: 1,
      shaderModuleSchemaVersion: 2,
      sourceKind: 'wgsl',
      toolchain: {
        cookerId: 'aether-native-wgsl-cooker',
        cookerVersion: '0.0.0',
        nagaVersion: '30.0.0'
      },
      source: { sourceUri },
      entryPoints: [
        { name: 'vertexMain', stage: 'vertex', bindings: [sceneBinding] },
        {
          name: 'fragmentMain',
          stage: 'fragment',
          bindings: [textureBinding, samplerBinding]
        }
      ],
      bindings: [sceneBinding, textureBinding, samplerBinding]
    });
    expect(artifact.source.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.source.byteLength).toBeGreaterThan(0);
    expect(artifact.modules.wgsl).toContain('@vertex\nfn vertexMain');
    expect(Object.keys(artifact.modules.glslEs300)).toEqual([
      'fragment:fragmentMain',
      'vertex:vertexMain'
    ]);
    for (const glsl of Object.values<{ source: string; bindings: readonly unknown[] }>(
      artifact.modules.glslEs300
    )) {
      expect(glsl.source).toMatch(/^#version 300 es/);
      expect(glsl.source).toContain('void main()');
      expect(Array.isArray(glsl.bindings)).toBe(true);
    }
  });

  test('returns a structured nonzero diagnostic for invalid committed WGSL', () => {
    const sourceUri = 'package://shader/invalid.wgsl';
    const result = cook('invalid.wgsl', sourceUri);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain(process.cwd());
    expect(JSON.parse(result.stderr)).toMatchObject({
      schemaVersion: 2,
      severity: 'error',
      code: 'wgsl-parse-failed',
      sourceUri,
      backendStage: 'parse'
    });
  });
});
