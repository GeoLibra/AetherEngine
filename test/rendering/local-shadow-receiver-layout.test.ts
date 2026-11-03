import { expect, test } from 'vitest';
import {
  buildLocalShadowReceiverLayout,
  buildLocalShadowRequests,
  packLocalShadowReceiverUniform,
  type PreparedLight
} from '../../src';

test('assigns explicit spot and contiguous point receiver depth-array layers', () => {
  const lights = [
    {
      entity: 1 as never,
      payloadVersion: 1,
      kind: 'spot',
      position: [0, 3, 0],
      direction: [0, -1, 0],
      colorLinear: [1, 1, 1],
      luminousIntensityCandela: 2,
      range: 8,
      innerRadians: 0.1,
      outerRadians: 0.2,
      enabled: true,
      layerMask: 1,
      castsShadow: true
    },
    {
      entity: 2 as never,
      payloadVersion: 1,
      kind: 'point',
      position: [0, 0, 0],
      colorLinear: [1, 1, 1],
      luminousIntensityCandela: 2,
      range: 5,
      enabled: true,
      layerMask: 1,
      castsShadow: true
    }
  ] as const satisfies readonly PreparedLight[];
  const requests = buildLocalShadowRequests({
    viewId: 'main',
    lights,
    resolutionClass: 512,
    casterRevision: 1
  });
  expect(buildLocalShadowReceiverLayout({ requests, lights, firstLayer: 4 })).toEqual([
    expect.objectContaining({ lightIndex: 0, kind: 'spot', baseLayer: 4, near: 0.0008, far: 8 }),
    expect.objectContaining({ lightIndex: 1, kind: 'point', baseLayer: 5, near: 0.0005, far: 5 })
  ]);
});

test('packs a fixed receiver uniform ABI with point and spot discriminators', () => {
  const words = packLocalShadowReceiverUniform(
    [
      { lightIndex: 3, kind: 'point', baseLayer: 4, near: 0.1, far: 10 },
      {
        lightIndex: 7,
        kind: 'spot',
        baseLayer: 10,
        near: 0.2,
        far: 20,
        viewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
      }
    ],
    2
  );
  expect([...words.slice(0, 8)]).toEqual([2, 0, 0, 0, 3, 1, 4, 0]);
  expect(new Float32Array(words.buffer)[8]).toBeCloseTo(0.1);
  expect(new Float32Array(words.buffer)[9]).toBeCloseTo(10);
  expect([...words.slice(24, 28)]).toEqual([7, 0, 10, 0]);
});
