import { describe, expect, it } from 'vitest';
import {
  evaluatePassMerging,
  packSkyboxUniforms,
  SKYBOX_UNIFORM_BYTE_SIZE
} from '../../../src/rendering/background';

describe('background pass merging and structural metrics', () => {
  it('selects 1 physical render pass when background and opaque are adjacent and compatible', () => {
    const decision = evaluatePassMerging({
      backgroundEnabled: true,
      backgroundRepresentation: 'panorama',
      colorFormat: 'rgba16float',
      depthFormat: 'depth24plus',
      width: 1920,
      height: 1080
    });

    expect(decision.canMerge).toBe(true);
    expect(decision.reason).toBe('adjacent-compatible-attachments');
    expect(decision.physicalPassCount).toBe(1);
    expect(decision.colorAttachmentOperations).toBe(2); // 1 clear/load, 1 store
    expect(decision.depthAttachmentOperations).toBe(2); // 1 clear/load, 1 store
    expect(decision.totalAttachmentOperations).toBe(4);
  });

  it('selects 2 physical passes when separate execution is explicitly forced', () => {
    const decision = evaluatePassMerging({
      backgroundEnabled: true,
      backgroundRepresentation: 'panorama',
      colorFormat: 'rgba16float',
      depthFormat: 'depth24plus',
      width: 1920,
      height: 1080,
      forceSeparate: true
    });

    expect(decision.canMerge).toBe(false);
    expect(decision.reason).toBe('forced-separate');
    expect(decision.physicalPassCount).toBe(2);
    expect(decision.colorAttachmentOperations).toBe(4); // Pass 1: clear+store, Pass 2: load+store
    expect(decision.depthAttachmentOperations).toBe(2); // Pass 2: clear+store
    expect(decision.totalAttachmentOperations).toBe(6);
  });

  it('rejects merging when an intervening resource dependency exists', () => {
    const decision = evaluatePassMerging({
      backgroundEnabled: true,
      backgroundRepresentation: 'radiance-level-zero',
      colorFormat: 'rgba16float',
      depthFormat: 'depth24plus',
      width: 1920,
      height: 1080,
      hasInterveningDependency: true
    });

    expect(decision.canMerge).toBe(false);
    expect(decision.reason).toBe('intervening-resource-dependency');
    expect(decision.physicalPassCount).toBe(2);
    expect(decision.totalAttachmentOperations).toBe(6);
  });

  it('handles background representation none with 1 physical pass for opaque only', () => {
    const decision = evaluatePassMerging({
      backgroundEnabled: true,
      backgroundRepresentation: 'none',
      colorFormat: 'rgba16float',
      width: 1920,
      height: 1080
    });

    expect(decision.canMerge).toBe(false);
    expect(decision.reason).toBe('background-none');
    expect(decision.physicalPassCount).toBe(1);
    expect(decision.totalAttachmentOperations).toBe(4);
  });

  it('packs skybox uniforms with exact 240-byte WGSL alignment', () => {
    const data = packSkyboxUniforms({
      vertexRays: {
        ray0: [1, 2, 3],
        ray1: [4, 5, 6],
        ray2: [7, 8, 9]
      },
      invProj: new Float32Array(16),
      envRot: new Float32Array(16),
      intensity: 2.5,
      multiplier: 1.5,
      maxLod: 8,
      textureWidth: 1024,
      textureHeight: 512,
      reconstructionMode: 'vertex',
      representation: 'panorama',
      depthMode: 'standard',
      projectionKind: 'perspective'
    });

    expect(data.byteLength).toBe(SKYBOX_UNIFORM_BYTE_SIZE);
    expect(data.length).toBe(60);

    // ray0, ray1, ray2
    expect(data[0]).toBe(1);
    expect(data[1]).toBe(2);
    expect(data[2]).toBe(3);
    expect(data[3]).toBe(0);

    expect(data[4]).toBe(4);
    expect(data[5]).toBe(5);
    expect(data[6]).toBe(6);

    expect(data[8]).toBe(7);
    expect(data[9]).toBe(8);
    expect(data[10]).toBe(9);

    // params (intensity * multiplier = 3.75, maxLod = 8, width = 1024, height = 512)
    expect(data[48]).toBeCloseTo(3.75);
    expect(data[49]).toBe(8);
    expect(data[50]).toBe(1024);
    expect(data[51]).toBe(512);

    // flags (reconstructionMode=0, representation=0, depthMode=0, projectionKind=0)
    expect(data[52]).toBe(0); // vertex mode
    expect(data[53]).toBe(0); // panorama
    expect(data[54]).toBe(0); // standard depth
    expect(data[55]).toBe(0); // perspective
  });
});
