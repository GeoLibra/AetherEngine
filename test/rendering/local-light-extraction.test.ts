import { expect, test } from 'vitest';
import {
  LocalLightExtraction,
  LocalLightField,
  PointLightSource,
  RenderWorld,
  SpotLightSource,
  World,
  createLocalLightExtractorPlan
} from '../../src';

test('publishes stable point and spot facts and removes absent local sources', () => {
  const main = new World().registerComponent(PointLightSource).registerComponent(SpotLightSource);
  const render = new RenderWorld({ extractorPlan: createLocalLightExtractorPlan() });
  const extraction = new LocalLightExtraction(main, render);
  const point = main
    .spawn()
    .insert(PointLightSource, {
      position: [1, 2, 3],
      colorLinear: [1, 1, 1],
      luminousIntensityCandela: 2,
      range: 4,
      enabled: true,
      layerMask: 1,
      castsShadow: false
    })
    .build();
  const spot = main
    .spawn()
    .insert(SpotLightSource, {
      position: [0, 1, 0],
      direction: [0, -2, 0],
      colorLinear: [1, 0, 0],
      luminousIntensityCandela: 3,
      range: 5,
      innerRadians: 0.1,
      outerRadians: 0.2,
      enabled: true,
      layerMask: 1,
      castsShadow: true
    })
    .build();
  extraction.extract({ sourceTick: 1 }).release();
  expect(render.read(render.mapEntity(point), LocalLightField)).toMatchObject({
    kind: 'point',
    range: 4
  });
  expect(render.read(render.mapEntity(spot), LocalLightField)).toMatchObject({
    kind: 'spot',
    direction: [0, -1, 0]
  });
  main.removeComponent(point, PointLightSource);
  const revision = extraction.extract({ sourceTick: 2 });
  expect(extraction.lights()).toHaveLength(1);
  expect(revision.diff.changes.some((change) => change.kind === 'entity-removed')).toBe(true);
  revision.release();
});
