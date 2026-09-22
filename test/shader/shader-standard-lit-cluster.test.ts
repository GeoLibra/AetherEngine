import { expect, test } from 'vitest';
import {
  STANDARD_LIT_CLUSTER_SHADER_ABI_VERSION,
  STANDARD_LIT_CLUSTER_SHADER_MODULE_KEY,
  STANDARD_LIT_CLUSTER_WEBGPU_SHADER_ARTIFACT
} from '../../src';

test('publishes a WebGPU clustered-forward fragment consumer with explicit metadata ABI', () => {
  const fragment = STANDARD_LIT_CLUSTER_WEBGPU_SHADER_ARTIFACT.entryPoints.find(
    ({ name }) => name === 'standardLitFragment'
  );
  expect(STANDARD_LIT_CLUSTER_SHADER_MODULE_KEY).toBe('aether.shader.standard-lit-cluster.v1');
  expect(STANDARD_LIT_CLUSTER_SHADER_ABI_VERSION).toBe(1);
  expect(fragment?.bindings).toContainEqual(
    expect.objectContaining({
      group: 3,
      binding: 14,
      name: 'clusterMetadata',
      kind: 'uniform-buffer'
    })
  );
  const source = STANDARD_LIT_CLUSTER_WEBGPU_SHADER_ARTIFACT.modules.wgsl;
  expect(source).toContain('fn selectClusterHeader');
  expect(source).toContain('let cameraDepth = -(viewData.view * vec4<f32>(worldPosition, 1.0)).z;');
  expect(source).toContain('let cluster = (slice * tilesY + tileY) * tilesX + tileX;');
  expect(source).toContain('indexWords.values[wordIndex / 4u][wordIndex % 4u]');
});
