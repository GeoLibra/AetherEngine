import { describe, expect, test } from 'vitest';
import { decodeCookedShaderPackage } from '../../src';
import { STANDARD_LIT_SHADER_ABI_VERSION, STANDARD_LIT_SHADER_ARTIFACT } from '../../src/shader';
import { NativeWgslRecookAdapter } from '../../tools/asset-cook';
import type { NativeWgslCooker } from '../../tools/shader-cooker';

describe('NativeWgslRecookAdapter', () => {
  test('cooks a registered source into a render package with dependency and toolchain identity', async () => {
    const requests: unknown[] = [];
    const nativeCooker = {
      async cook(request: unknown) {
        requests.push(request);
        return STANDARD_LIT_SHADER_ARTIFACT;
      }
    } as NativeWgslCooker;
    const adapter = new NativeWgslRecookAdapter({
      nativeCooker,
      packageToolchain: { id: 'aether-render-package', version: '1.0.0' }
    });
    adapter.register({
      nodeId: 'asset://shaders/standard-lit.wgsl',
      sourcePath: '/workspace/shaders/standard-lit.wgsl',
      sourceUri: 'asset://shaders/standard-lit.wgsl',
      dependencies: ['asset://shaders/pbr-library.wgsl'],
      shaderAbiVersion: STANDARD_LIT_SHADER_ABI_VERSION,
      sourceLanguageVersion: 'wgsl-1',
      metadataSchemaVersion: 1
    });

    const result = await adapter.cook('asset://shaders/standard-lit.wgsl', 7);
    const decoded = await decodeCookedShaderPackage(result.bundle);

    expect(requests).toEqual([
      {
        sourcePath: '/workspace/shaders/standard-lit.wgsl',
        sourceUri: 'asset://shaders/standard-lit.wgsl'
      }
    ]);
    expect(decoded.artifact).toEqual(STANDARD_LIT_SHADER_ARTIFACT);
    expect(result.dependencies).toEqual(['asset://shaders/pbr-library.wgsl']);
    expect(result.inputHashes).toEqual([STANDARD_LIT_SHADER_ARTIFACT.source.contentHash]);
    expect(result.toolchainVersion).toBe('aether-native-wgsl-cooker@0.0.0+naga@30.0.0');
  });

  test('rejects an unregistered source node', async () => {
    const adapter = new NativeWgslRecookAdapter({
      nativeCooker: {} as NativeWgslCooker,
      packageToolchain: { id: 'aether-render-package', version: '1.0.0' }
    });

    await expect(adapter.cook('asset://shaders/missing.wgsl', 1)).rejects.toThrow(
      'Shader cook source is not registered: asset://shaders/missing.wgsl'
    );
  });
});
