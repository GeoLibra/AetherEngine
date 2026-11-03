import { expect, test } from 'vitest';
import { PointLightSource, SpotLightSource, World } from '../../src';

test('validates finite point-light physical intent at ECS insertion', () => {
  const world = new World().registerComponent(PointLightSource);
  const entity = world
    .spawn()
    .insert(PointLightSource, {
      position: [1, 2, 3],
      colorLinear: [1, 0.5, 0],
      luminousIntensityCandela: 20,
      range: 5,
      enabled: true,
      layerMask: 1,
      castsShadow: true
    })
    .build();
  expect(world.getComponent(entity, PointLightSource)).toMatchObject({ range: 5 });
  expect(() =>
    world
      .spawn()
      .insert(PointLightSource, {
        position: [0, 0, 0],
        colorLinear: [1, 1, 1],
        luminousIntensityCandela: 1,
        range: 0,
        enabled: true,
        layerMask: 1,
        castsShadow: false
      })
      .build()
  ).toThrow(/range/);
});

test('normalizes spot axes and rejects invalid cone angles', () => {
  const world = new World().registerComponent(SpotLightSource);
  const entity = world
    .spawn()
    .insert(SpotLightSource, {
      position: [0, 0, 0],
      direction: [0, 0, -2],
      colorLinear: [1, 1, 1],
      luminousIntensityCandela: 10,
      range: 8,
      innerRadians: 0.2,
      outerRadians: 0.4,
      enabled: true,
      layerMask: 1,
      castsShadow: true
    })
    .build();
  expect(world.getComponent(entity, SpotLightSource)?.direction).toEqual([0, 0, -1]);
  expect(() =>
    world
      .spawn()
      .insert(SpotLightSource, {
        position: [0, 0, 0],
        direction: [0, 0, -1],
        colorLinear: [1, 1, 1],
        luminousIntensityCandela: 10,
        range: 8,
        innerRadians: 0.5,
        outerRadians: 0.4,
        enabled: true,
        layerMask: 1,
        castsShadow: true
      })
      .build()
  ).toThrow(/angles/);
});
