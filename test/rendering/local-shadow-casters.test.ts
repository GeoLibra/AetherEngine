import { expect, test } from 'vitest';
import {
  buildLocalShadowCasterViews,
  buildLocalShadowRequests,
  type PreparedLight
} from '../../src';

test('builds one spot and six finite point caster projections in canonical face order', () => {
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
  const views = buildLocalShadowCasterViews({ requests, lights });
  expect(views).toHaveLength(7);
  expect(views.map((view) => view.request.subresourceIndex)).toEqual([0, 0, 1, 2, 3, 4, 5]);
  expect(
    views.every(
      (view) => view.viewProjection.length === 16 && view.viewProjection.every(Number.isFinite)
    )
  ).toBe(true);
});
