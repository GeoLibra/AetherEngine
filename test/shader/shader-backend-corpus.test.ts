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
    const sourceUri = 'asset://shader/basic.wgsl';
    const result = cook('basic.wgsl', sourceUri);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const artifact = JSON.parse(result.stdout);
    expect(artifact).toMatchObject({
      schemaVersion: 1,
      shaderManifestSchemaVersion: 1,
      shaderModuleSchemaVersion: 1,
      sourceKind: 'wgsl',
      toolchain: {
        cookerId: 'aether-native-wgsl-cooker',
        cookerVersion: '0.0.0',
        nagaVersion: '30.0.0'
      },
      source: { sourceUri },
      entryPoints: [
        { name: 'vertexMain', stage: 'vertex' },
        { name: 'fragmentMain', stage: 'fragment' }
      ],
      bindings: []
    });
    expect(artifact.source.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.source.byteLength).toBeGreaterThan(0);
    expect(
      artifact.entryPoints.every((entry: { bindings: unknown[] }) => entry.bindings.length === 0)
    ).toBe(true);
    expect(artifact.modules.wgsl).toContain('@vertex\nfn vertexMain');
    expect(Object.keys(artifact.modules.glslEs300)).toEqual([
      'fragment:fragmentMain',
      'vertex:vertexMain'
    ]);
    for (const glsl of Object.values<string>(artifact.modules.glslEs300)) {
      expect(glsl).toMatch(/^#version 300 es/);
      expect(glsl).toContain('void main()');
    }
  });

  test('returns a structured nonzero diagnostic for invalid committed WGSL', () => {
    const sourceUri = 'package://shader/invalid.wgsl';
    const result = cook('invalid.wgsl', sourceUri);

    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({
      schemaVersion: 1,
      severity: 'error',
      code: 'wgsl-parse-failed',
      sourceUri,
      backendStage: 'parse'
    });
  });
});
