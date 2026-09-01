import { describe, expect, test } from 'vitest';
import {
  parseFluxShader,
  lexFluxSource,
  InMemoryShaderSourceResolver,
  ShaderCompiler,
  cookShaderArtifact,
  ShaderGraphCompiler,
  cookAuthoredShader,
  NativeWgslCooker,
  loadWgslMetadata,
  nativeWgslPlugin
} from '../../src/shader-tooling';

describe('Shader tooling subpath exports', () => {
  test('exports FluxSL frontend parsing and source resolution tools', () => {
    expect(typeof parseFluxShader).toBe('function');
    expect(typeof lexFluxSource).toBe('function');
    expect(typeof InMemoryShaderSourceResolver).toBe('function');
  });

  test('exports ShaderCompiler, cookShaderArtifact, and ShaderGraphCompiler', () => {
    expect(typeof ShaderCompiler).toBe('function');
    expect(typeof cookShaderArtifact).toBe('function');
    expect(typeof ShaderGraphCompiler).toBe('function');
  });

  test('exports native WGSL cooker tools and Vite plugin', () => {
    expect(typeof cookAuthoredShader).toBe('function');
    expect(typeof NativeWgslCooker).toBe('function');
    expect(typeof loadWgslMetadata).toBe('function');
    expect(typeof nativeWgslPlugin).toBe('function');
  });
});
