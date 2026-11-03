import { expect, test } from 'vitest';
import { buildLocalShadowRequests, type PreparedLight } from '../../src';

test('creates one spot and six ordered point-face requests while excluding disabled lights', () => {
  const lights = [
    {
      entity: 4 as never,
      payloadVersion: 1,
      kind: 'point',
      position: [0, 0, 0],
      colorLinear: [1, 1, 1],
      luminousIntensityCandela: 2,
      range: 3,
      enabled: true,
      layerMask: 1,
      castsShadow: true
    },
    {
      entity: 2 as never,
      payloadVersion: 1,
      kind: 'spot',
      position: [0, 1, 0],
      direction: [0, -1, 0],
      colorLinear: [1, 1, 1],
      luminousIntensityCandela: 3,
      range: 4,
      innerRadians: 0.1,
      outerRadians: 0.2,
      enabled: true,
      layerMask: 1,
      castsShadow: true
    },
    {
      entity: 1 as never,
      payloadVersion: 1,
      kind: 'point',
      position: [0, 0, 0],
      colorLinear: [1, 1, 1],
      luminousIntensityCandela: 2,
      range: 3,
      enabled: false,
      layerMask: 1,
      castsShadow: true
    }
  ] as const satisfies readonly PreparedLight[];
  const requests = buildLocalShadowRequests({
    viewId: 'main',
    lights,
    resolutionClass: 512,
    casterRevision: 8
  });
  expect(requests).toHaveLength(7);
  expect(requests[0]).toMatchObject({ lightEntity: 2, kind: 'spot', subresourceIndex: 0 });
  expect(requests.slice(1).map((request) => request.subresourceIndex)).toEqual([0, 1, 2, 3, 4, 5]);
});
