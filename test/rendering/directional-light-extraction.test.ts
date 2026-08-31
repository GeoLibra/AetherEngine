import { describe, expect, test } from 'vitest';
import {
  DirectionalLightExtraction,
  DirectionalLightField,
  DirectionalLightSource,
  RenderWorld,
  World,
  createDirectionalLightExtractorPlan
} from '../../src';

function source(direction: readonly [number, number, number] = [0, -2, 0]) {
  return {
    direction,
    colorLinear: [1, 0.5, 0.25] as const,
    illuminanceLux: 12_000,
    enabled: true,
    layerMask: 0x03,
    castsShadow: false
  };
}

function fixture() {
  const main = new World().registerComponent(DirectionalLightSource);
  const render = new RenderWorld({ extractorPlan: createDirectionalLightExtractorPlan() });
  const extraction = new DirectionalLightExtraction(main, render);
  return { main, render, extraction };
}

describe('directional light extraction', () => {
  test('validates physical intent and publishes normalized immutable world-space facts', () => {
    const { main, render, extraction } = fixture();
    const entity = main.spawn().insert(DirectionalLightSource, source()).build();

    const revision = extraction.extract({ sourceTick: 1 });
    const renderEntity = render.mapEntity(entity);
    expect(render.read(renderEntity, DirectionalLightField)).toEqual({
      entity: renderEntity,
      payloadVersion: 1,
      kind: 'directional',
      direction: [0, -1, 0],
      colorLinear: [1, 0.5, 0.25],
      illuminanceLux: 12_000,
      enabled: true,
      layerMask: 3,
      castsShadow: false
    });
    revision.release();
  });

  test('uses deterministic entity order and publishes tombstones for removed sources', () => {
    const { main, render, extraction } = fixture();
    const second = main
      .spawn()
      .insert(DirectionalLightSource, source([1, 0, 0]))
      .build();
    const first = main
      .spawn()
      .insert(DirectionalLightSource, source([0, 0, -1]))
      .build();
    extraction.extract({ sourceTick: 1 }).release();

    expect(extraction.lights().map((light) => light.entity)).toEqual(
      [render.mapEntity(second), render.mapEntity(first)].sort((left, right) => left - right)
    );

    main.removeComponent(second, DirectionalLightSource);
    const revision = extraction.extract({ sourceTick: 2 });
    expect(extraction.lights().map((light) => light.entity)).toEqual([render.mapEntity(first)]);
    expect(revision.diff.changes.some((change) => change.kind === 'entity-removed')).toBe(true);
    revision.release();
  });

  test('replaces the render generation after same-tick source removal and reinsertion', () => {
    const { main, render, extraction } = fixture();
    const entity = main.spawn().insert(DirectionalLightSource, source()).build();
    extraction.extract({ sourceTick: 1 }).release();
    const previous = render.mapEntity(entity);

    main.removeComponent(entity, DirectionalLightSource);
    main.insertComponent(entity, DirectionalLightSource, source([1, 0, 0]));
    const revision = extraction.extract({ sourceTick: 2 });

    expect(render.mapEntity(entity)).not.toBe(previous);
    expect(revision.diff.changes.map((change) => change.kind).sort()).toEqual([
      'entity-added',
      'entity-removed'
    ]);
    revision.release();
  });

  test.each([
    ['zero direction', source([0, 0, 0])],
    ['negative lux', { ...source(), illuminanceLux: -1 }],
    ['nonlinear color', { ...source(), colorLinear: [1, -0.1, 0] }],
    ['invalid layer mask', { ...source(), layerMask: 0x1_0000_0000 }]
  ])('rejects invalid %s at the MainWorld trust boundary', (_label, value) => {
    const { main } = fixture();
    expect(() => main.spawn().insert(DirectionalLightSource, value).build()).toThrow();
  });

  test('rejects backwards ticks and use after disposal', () => {
    const { extraction } = fixture();
    extraction.extract({ sourceTick: 2 }).release();
    expect(() => extraction.extract({ sourceTick: 1 })).toThrow(/monotonic/i);
    extraction.dispose();
    expect(() => extraction.extract({ sourceTick: 3 })).toThrow(/disposed/i);
  });
});
