import { describe, expect, it } from 'vitest';
import { decodeWebGpuLightListOutput } from '../../src/rendering/lighting/culling/light-list-abi';
import { decodeWebGlLightListOutput } from '../../src/rendering/lighting/culling/light-list-webgl-abi';
import {
  packCpuLightListForWebGpu,
  packCpuLightListForWebGl
} from '../../src/rendering/baseline/light-list/cpu-light-list-upload';
import type {
  CpuLightListCapacity,
  CpuLightListResult,
  LightReceiver,
  PreparedLight
} from '../../src/rendering/lighting/types';
import type { RenderEntityId } from '../../src/rendering/world';

describe('CPU LightList ABI packing oracles', () => {
  const capacity: CpuLightListCapacity = {
    maxLightsPerReceiver: 8,
    maxDirectionalLights: 4,
    maxLightIndices: 32
  };

  const sampleLights: readonly PreparedLight[] = [
    {
      entity: 1 as RenderEntityId,
      payloadVersion: 0,
      kind: 'directional',
      enabled: true,
      castsShadow: false,
      layerMask: 1,
      direction: [0, -1, 0],
      colorLinear: [1, 1, 1],
      illuminanceLux: 1000
    },
    {
      entity: 2 as RenderEntityId,
      payloadVersion: 0,
      kind: 'point',
      enabled: true,
      castsShadow: false,
      layerMask: 1,
      position: [0, 2, 0],
      range: 10,
      colorLinear: [1, 0.5, 0],
      luminousIntensityCandela: 500
    }
  ];

  const sampleReceivers: readonly LightReceiver[] = [
    {
      renderEntity: 10 as RenderEntityId,
      layerMask: 1,
      bounds: { kind: 'sphere', center: [0, 0, 0], radius: 5 }
    },
    {
      renderEntity: 20 as RenderEntityId,
      layerMask: 1,
      bounds: { kind: 'sphere', center: [10, 0, 0], radius: 5 }
    }
  ];

  const sampleCpuResult: CpuLightListResult = {
    source: 'cpu-list',
    fallback: 'none',
    orderedLights: sampleLights,
    globalDirectionalLightIndices: [0],
    headers: [
      { receiver: 10 as RenderEntityId, offset: 0, count: 1, overflowed: false },
      { receiver: 20 as RenderEntityId, offset: 1, count: 0, overflowed: false }
    ],
    lightIndices: [1],
    capacity,
    overflowed: false,
    counters: {
      inputLights: 2,
      inputReceivers: 2,
      disabledLights: 0,
      layerRejectedLights: 0,
      disabledReceivers: 0,
      layerRejectedReceivers: 0,
      candidatePairs: 2,
      intersectionTests: 2,
      directionalCount: 1,
      directionalTruncated: 0,
      emittedIndices: 1,
      overflowedReceivers: 0,
      truncatedIndices: 0
    }
  };

  it('packs for WebGPU and decodes cleanly via decodeWebGpuLightListOutput', () => {
    const packed = packCpuLightListForWebGpu(
      {
        viewLayerMask: 1,
        lights: sampleLights,
        receivers: sampleReceivers
      },
      capacity,
      sampleCpuResult
    );

    const decoded = decodeWebGpuLightListOutput({
      directionalIndices: packed.directionalWords,
      headers: packed.headerWords,
      lightIndices: packed.indexWords,
      overflow: packed.overflowWords
    });

    expect(decoded.overflowed).toBe(false);
    expect(decoded.directionalIndices).toEqual([0]);
    expect(decoded.headers).toHaveLength(2);
    expect(decoded.headers[0]).toEqual({
      receiver: 10,
      offset: 0,
      count: 1,
      overflowed: false
    });
    expect(decoded.headers[1]).toEqual({
      receiver: 20,
      offset: 1,
      count: 0,
      overflowed: false
    });
    expect(decoded.lightIndices).toEqual([1]);
  });

  it('packs for WebGL2 and decodes cleanly via decodeWebGlLightListOutput', () => {
    const packed = packCpuLightListForWebGl(
      {
        viewLayerMask: 1,
        lights: sampleLights,
        receivers: sampleReceivers
      },
      capacity,
      2048,
      sampleCpuResult
    );

    const decoded = decodeWebGlLightListOutput({
      receiverCount: sampleReceivers.length,
      capacity,
      width: packed.width,
      directional: packed.directionalTexels,
      headers: packed.headerTexels,
      indices: packed.indexTexels,
      overflow: packed.overflowTexels
    });

    expect(decoded.overflowed).toBe(false);
    expect(decoded.directionalIndices).toEqual([0]);
    expect(decoded.headers).toHaveLength(2);
    expect(decoded.headers[0]).toEqual({
      receiver: 10,
      offset: 0,
      count: 1,
      overflowed: false
    });
    expect(decoded.headers[1]).toEqual({
      receiver: 20,
      offset: 1,
      count: 0,
      overflowed: false
    });
    expect(decoded.lightIndices).toEqual([1]);
  });

  it('handles overflow and multi-row receiver packing correctly in both backends', () => {
    // 3 receivers with overflow
    const threeReceivers: readonly LightReceiver[] = [
      { renderEntity: 1 as RenderEntityId, layerMask: 1, bounds: { kind: 'sphere', center: [0, 0, 0], radius: 1 } },
      { renderEntity: 2 as RenderEntityId, layerMask: 1, bounds: { kind: 'sphere', center: [2, 0, 0], radius: 1 } },
      { renderEntity: 3 as RenderEntityId, layerMask: 1, bounds: { kind: 'sphere', center: [4, 0, 0], radius: 1 } }
    ];
    const overflowResult: CpuLightListResult = {
      source: 'cpu-list',
      fallback: 'deterministic-truncate',
      orderedLights: sampleLights,
      globalDirectionalLightIndices: [0],
      headers: [
        { receiver: 1 as RenderEntityId, offset: 0, count: 2, overflowed: false },
        { receiver: 2 as RenderEntityId, offset: 2, count: 1, overflowed: true },
        { receiver: 3 as RenderEntityId, offset: 3, count: 0, overflowed: false }
      ],
      lightIndices: [1, 2, 3],
      capacity,
      overflowed: true,
      counters: {
        inputLights: 2,
        inputReceivers: 3,
        disabledLights: 0,
        layerRejectedLights: 0,
        disabledReceivers: 0,
        layerRejectedReceivers: 0,
        candidatePairs: 3,
        intersectionTests: 3,
        directionalCount: 1,
        directionalTruncated: 0,
        emittedIndices: 3,
        overflowedReceivers: 1,
        truncatedIndices: 0
      }
    };

    // WebGPU test
    const gpuPacked = packCpuLightListForWebGpu(
      { viewLayerMask: 1, lights: sampleLights, receivers: threeReceivers },
      capacity,
      overflowResult
    );
    const gpuDecoded = decodeWebGpuLightListOutput({
      directionalIndices: gpuPacked.directionalWords,
      headers: gpuPacked.headerWords,
      lightIndices: gpuPacked.indexWords,
      overflow: gpuPacked.overflowWords
    });
    expect(gpuDecoded.overflowed).toBe(true);
    expect(gpuDecoded.headers[1]?.overflowed).toBe(true);
    expect(gpuDecoded.lightIndices).toEqual([1, 2, 3]);

    // WebGL2 test with a small width constraint to force multi-row blocks
    const glPacked = packCpuLightListForWebGl(
      { viewLayerMask: 1, lights: sampleLights, receivers: threeReceivers },
      capacity,
      16, // small max dimension forcing multi-row wrapping if receivers increase
      overflowResult
    );
    const glDecoded = decodeWebGlLightListOutput({
      receiverCount: threeReceivers.length,
      capacity,
      width: glPacked.width,
      directional: glPacked.directionalTexels,
      headers: glPacked.headerTexels,
      indices: glPacked.indexTexels,
      overflow: glPacked.overflowTexels
    });
    expect(glDecoded.overflowed).toBe(true);
    expect(glDecoded.headers[1]?.overflowed).toBe(true);
    expect(glDecoded.lightIndices).toEqual([1, 2, 3]);
  });
});
