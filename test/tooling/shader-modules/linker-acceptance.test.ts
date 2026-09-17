import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import {
  FileSystemShaderModuleLoader,
  linkStrictWgsl,
  resolveDependencyClosure
} from '../../../tools/shader-cooker/modules';
import {
  NativeCookerError,
  NativeWgslCooker
} from '../../../tools/shader-cooker/native-wgsl-cooker';
import { cookAuthoredShader } from '../../../tools/shader-cooker/authoring-dispatch';
import { defineShaderAuthoringSource } from '../../../src/shader/authoring';

const FIXTURES_ROOT = resolve(import.meta.dirname, 'fixtures');
const cooker = new NativeWgslCooker();
const loader = new FileSystemShaderModuleLoader({
  roots: { test: FIXTURES_ROOT }
});

describe('Shader Module Linker Acceptance Against Native Naga Cooker', () => {
  it('Fixture 1 & 5: Diamond dependency compiles cleanly with Naga via cookAuthoredShader', async () => {
    const rootUri = 'asset://test/diamond/root.wgsl';
    const rootPath = resolve(FIXTURES_ROOT, 'diamond/root.wgsl');
    const metadataPath = resolve(FIXTURES_ROOT, 'diamond/root.wgsl.meta.json');

    const artifact = await cookAuthoredShader(
      {
        source: defineShaderAuthoringSource({ kind: 'wgsl', uri: rootUri }),
        sourcePath: rootPath,
        metadataPath
      },
      { cooker, moduleLoader: loader }
    );

    const entryPointNames = artifact.entryPoints.map((ep) => ep.name);
    expect(entryPointNames).toContain('fs_main');
  });

  it('Fixture 2: Shared UV and coverage compiles for both Lit and Shadow roots', async () => {
    const litRootUri = 'asset://test/uv-coverage/lit_root.wgsl';
    const litRootPath = resolve(FIXTURES_ROOT, 'uv-coverage/lit_root.wgsl');
    const litMetaPath = resolve(FIXTURES_ROOT, 'uv-coverage/lit_root.wgsl.meta.json');

    const shadowRootUri = 'asset://test/uv-coverage/shadow_root.wgsl';
    const shadowRootPath = resolve(FIXTURES_ROOT, 'uv-coverage/shadow_root.wgsl');
    const shadowMetaPath = resolve(FIXTURES_ROOT, 'uv-coverage/shadow_root.wgsl.meta.json');

    const litArtifact = await cookAuthoredShader(
      {
        source: defineShaderAuthoringSource({ kind: 'wgsl', uri: litRootUri }),
        sourcePath: litRootPath,
        metadataPath: litMetaPath
      },
      { cooker, moduleLoader: loader }
    );

    const shadowArtifact = await cookAuthoredShader(
      {
        source: defineShaderAuthoringSource({ kind: 'wgsl', uri: shadowRootUri }),
        sourcePath: shadowRootPath,
        metadataPath: shadowMetaPath
      },
      { cooker, moduleLoader: loader }
    );

    expect(litArtifact.entryPoints.map((e) => e.name)).toContain('fs_main');
    expect(shadowArtifact.entryPoints.map((e) => e.name)).toContain('fs_main');
  });

  it('Fixture 3: Shared BRDF functions compile and emit valid GLSL ES', async () => {
    const rootUri = 'asset://test/brdf/root.wgsl';
    const rootPath = resolve(FIXTURES_ROOT, 'brdf/root.wgsl');
    const metadataPath = resolve(FIXTURES_ROOT, 'brdf/root.wgsl.meta.json');

    const artifact = await cookAuthoredShader(
      {
        source: defineShaderAuthoringSource({ kind: 'wgsl', uri: rootUri }),
        sourcePath: rootPath,
        metadataPath
      },
      { cooker, moduleLoader: loader }
    );

    expect(artifact.modules.glslEs300).toBeDefined();
    expect(Object.keys(artifact.modules.glslEs300).length).toBeGreaterThan(0);
  });

  it('Fixture 4: Bindings and struct layouts reflect accurately', async () => {
    const rootUri = 'asset://test/bindings/root.wgsl';
    const rootPath = resolve(FIXTURES_ROOT, 'bindings/root.wgsl');
    const metadataPath = resolve(FIXTURES_ROOT, 'bindings/root.wgsl.meta.json');

    const artifact = await cookAuthoredShader(
      {
        source: defineShaderAuthoringSource({ kind: 'wgsl', uri: rootUri }),
        sourcePath: rootPath,
        metadataPath
      },
      { cooker, moduleLoader: loader }
    );

    const binding = artifact.bindings.find((b) => b.name === 'materialParams');
    expect(binding).toBeDefined();
    expect(binding?.binding).toBe(0);
    expect(binding?.group).toBe(1);
    expect(binding?.kind).toBe('uniform-buffer');

    const layout = artifact.bufferLayouts.find((l) => l.name === 'materialParams');
    expect(layout).toBeDefined();
    expect(layout?.fields.length).toBe(2);
  });

  it('Fixture 6: Native compiler diagnostic in dependency is mapped accurately back to authoring leaf', async () => {
    const rootUri = 'asset://test/error-provenance/root.wgsl';
    const rootPath = resolve(FIXTURES_ROOT, 'error-provenance/root.wgsl');
    const metadataPath = resolve(FIXTURES_ROOT, 'error-provenance/root.wgsl.meta.json');

    await expect(
      cookAuthoredShader(
        {
          source: defineShaderAuthoringSource({ kind: 'wgsl', uri: rootUri }),
          sourcePath: rootPath,
          metadataPath
        },
        { cooker, moduleLoader: loader }
      )
    ).rejects.toThrow(NativeCookerError);

    try {
      await cookAuthoredShader(
        {
          source: defineShaderAuthoringSource({ kind: 'wgsl', uri: rootUri }),
          sourcePath: rootPath,
          metadataPath
        },
        { cooker, moduleLoader: loader }
      );
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(NativeCookerError);
      const cookerErr = err as NativeCookerError;
      expect(cookerErr.sourceUri).toBe('asset://test/error-provenance/leaf_with_error.wgsl');
      expect(cookerErr.line).toBe(3);
      expect(cookerErr.message).toContain('asset://test/error-provenance/leaf_with_error.wgsl:3');
    }
  });

  it('cookAuthoredShader respects in-memory request.metadata without requiring or using a disk sidecar metadata file', async () => {
    // Diamond root.wgsl has a disk sidecar, but here we invoke cooker WITHOUT metadataPath,
    // providing request.metadata directly in-memory.
    const rootUri = 'asset://test/diamond/root.wgsl';
    const rootPath = resolve(FIXTURES_ROOT, 'diamond/root.wgsl');

    const artifact = await cookAuthoredShader(
      {
        source: defineShaderAuthoringSource({ kind: 'wgsl', uri: rootUri }),
        sourcePath: rootPath,
        metadata: {
          schemaVersion: 1,
          entryPoints: [{ name: 'fs_main', stage: 'fragment' }],
          imports: [{ path: './b.wgsl' }, { path: './c.wgsl' }]
        }
      },
      { cooker } // Note: no custom moduleLoader, testing default FileSystemShaderModuleLoader path!
    );

    expect(artifact).toBeDefined();
    expect(artifact.entryPoints[0]?.name).toBe('fs_main');
    expect(artifact.source.sourceUri).toBe(rootUri);
  });
});
