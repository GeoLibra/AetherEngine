import { describe, expect, test } from 'vitest';
import {
  NativeWgslCooker,
  type NativeCookerProcessRunner
} from '../../tools/shader-cooker/native-wgsl-cooker';

const sampleValidArtifact = {
  schemaVersion: 2,
  shaderManifestSchemaVersion: 1,
  shaderModuleSchemaVersion: 2,
  sourceKind: 'wgsl',
  toolchain: {
    cookerId: 'aether-native-wgsl-cooker',
    cookerVersion: '0.0.0',
    nagaVersion: '30.0.0'
  },
  source: {
    sourceUri: 'asset://shaders/test.wgsl',
    contentHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    byteLength: 100
  },
  entryPoints: [
    {
      name: 'vertexMain',
      stage: 'vertex',
      bindings: []
    },
    {
      name: 'fragmentMain',
      stage: 'fragment',
      bindings: []
    }
  ],
  bindings: [],
  bufferLayouts: [],
  vertexInputs: [],
  fragmentOutputs: [],
  modules: {
    wgsl: '@vertex\nfn vertexMain() {}\n@fragment\nfn fragmentMain() {}',
    glslEs300: {
      'vertex:vertexMain': { source: '#version 300 es\nvoid main() {}', bindings: [] },
      'fragment:fragmentMain': { source: '#version 300 es\nvoid main() {}', bindings: [] }
    }
  }
};

describe('NativeWgslCooker adapter', () => {
  test('formats cargo command arguments and decodes valid JSON artifact stdout', async () => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const mockRunner: NativeCookerProcessRunner = async (command, args) => {
      calls.push({ command, args });
      return {
        status: 0,
        stdout: JSON.stringify(sampleValidArtifact),
        stderr: ''
      };
    };

    const cooker = new NativeWgslCooker({
      runner: mockRunner,
      cargoPath: 'cargo',
      manifestPath: 'tools/naga-shader-validator/Cargo.toml'
    });

    const result = await cooker.cook({
      sourcePath: '/workspace/shaders/test.wgsl',
      sourceUri: 'asset://shaders/test.wgsl'
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      command: 'cargo',
      args: [
        '+1.95.0',
        'run',
        '--quiet',
        '--manifest-path',
        'tools/naga-shader-validator/Cargo.toml',
        '--',
        'cook',
        '/workspace/shaders/test.wgsl',
        '--source-uri',
        'asset://shaders/test.wgsl'
      ]
    });

    expect(result).toEqual(sampleValidArtifact);
    expect(Object.isFrozen(result)).toBe(true);
  });

  test('accepts custom manifest path and cargo path', async () => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const mockRunner: NativeCookerProcessRunner = async (command, args) => {
      calls.push({ command, args });
      return {
        status: 0,
        stdout: JSON.stringify(sampleValidArtifact),
        stderr: ''
      };
    };

    const cooker = new NativeWgslCooker({
      runner: mockRunner,
      cargoPath: 'custom-cargo',
      manifestPath: 'custom/Cargo.toml'
    });

    await cooker.cook({
      sourcePath: '/workspace/shaders/test.wgsl',
      sourceUri: 'asset://shaders/test.wgsl'
    });

    expect(calls[0]?.command).toBe('custom-cargo');
    expect(calls[0]?.args).toContain('custom/Cargo.toml');
  });

  test('maps structured stderr JSON diagnostic on cooker failure and redacts local path', async () => {
    const mockRunner: NativeCookerProcessRunner = async () => ({
      status: 1,
      stdout: '',
      stderr: JSON.stringify({
        schemaVersion: 1,
        severity: 'error',
        code: 'wgsl-parse-failed',
        sourceUri: 'asset://shaders/test.wgsl',
        message: 'expected semicolon',
        location: { line: 10, column: 5 }
      })
    });

    const cooker = new NativeWgslCooker({ runner: mockRunner });

    await expect(
      cooker.cook({
        sourcePath: '/Users/secret/path/to/test.wgsl',
        sourceUri: 'asset://shaders/test.wgsl'
      })
    ).rejects.toThrowError(/wgsl-parse-failed/i);
  });

  test('reports toolchain installation remediation when cargo command fails', async () => {
    const mockRunner: NativeCookerProcessRunner = async () => {
      throw new Error('spawn cargo ENOENT');
    };

    const cooker = new NativeWgslCooker({ runner: mockRunner });

    await expect(
      cooker.cook({
        sourcePath: '/workspace/test.wgsl',
        sourceUri: 'asset://shaders/test.wgsl'
      })
    ).rejects.toThrowError(/rustup toolchain install 1\.95\.0/i);
  });

  test('rejects immediately when AbortSignal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const cooker = new NativeWgslCooker();
    await expect(
      cooker.cook(
        {
          sourcePath: '/workspace/test.wgsl',
          sourceUri: 'asset://shaders/test.wgsl'
        },
        { signal: controller.signal }
      )
    ).rejects.toThrowError(/aborted/i);
  });
});
