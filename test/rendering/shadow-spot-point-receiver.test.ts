import { describe, expect, test } from 'vitest';
import {
  buildPointShadowFaceViewProjection,
  buildSpotShadowViewProjection,
  mapShadowToAtlasTile,
  pointShadowFaceIndexAndUv,
  projectPointToShadowSpace,
  sampleShadowDepthMapPcf,
  sampleSpotShadowAtlas,
  type ShadowAtlasTileHandle
} from '../../src/rendering';
import { Mat4 } from '../../src/math';

describe('spot shadow view-projection oracle', () => {
  test('projects the cone axis center to the shadow-map center', () => {
    const vp = buildSpotShadowViewProjection({
      position: [0, 0, 0],
      direction: [0, 0, 1],
      range: 10,
      outerRadians: Math.PI / 6
    });
    const sample = projectPointToShadowSpace(vp, [0, 0, 5]);
    expect(sample).toBeDefined();
    expect(sample!.uv[0]).toBeCloseTo(0.5, 6);
    expect(sample!.uv[1]).toBeCloseTo(0.5, 6);
    expect(sample!.depth).toBeGreaterThan(0);
    expect(sample!.depth).toBeLessThan(1);
  });

  test('off-axis points land inside the cone and far outside is rejected', () => {
    const vp = buildSpotShadowViewProjection({
      position: [0, 0, 0],
      direction: [0, 0, 1],
      range: 10,
      outerRadians: Math.PI / 6
    });
    const inside = projectPointToShadowSpace(vp, [0, 2, 5]);
    expect(inside).toBeDefined();
    expect(inside!.uv[1]).toBeCloseTo(0.5, 6);
    expect(inside!.uv[0]).not.toBeCloseTo(0.5, 1);
    expect(projectPointToShadowSpace(vp, [0, 6, 5])).toBeUndefined();
    expect(projectPointToShadowSpace(vp, [6, 0, 5])).toBeUndefined();
  });

  test('points just before the far plane map to depth close to one', () => {
    const vp = buildSpotShadowViewProjection({
      position: [0, 0, 0],
      direction: [0, 0, 1],
      range: 10,
      outerRadians: Math.PI / 6
    });
    const sample = projectPointToShadowSpace(vp, [0, 0, 9.99]);
    expect(sample).toBeDefined();
    expect(sample!.depth).toBeGreaterThan(0.99);
  });

  test('the spot view-projection is invertible', () => {
    const vp = buildSpotShadowViewProjection({
      position: [1, 2, 3],
      direction: [-0.5, 1, 0.2],
      range: 10,
      outerRadians: Math.PI / 6
    });
    const roundTrip = Mat4.invert(vp);
    const point = Mat4.transformPoint(roundTrip, [0, 0, -2.5]);
    expect(Number.isFinite(point[0])).toBe(true);
    expect(point.some(Number.isNaN)).toBe(false);
  });

  test('rejects degenerate spot projections', () => {
    expect(() =>
      buildSpotShadowViewProjection({
        position: [0, 0, 0],
        direction: [0, 0, 0],
        range: 10,
        outerRadians: Math.PI / 6
      })
    ).toThrow(/non-zero/);
    expect(() =>
      buildSpotShadowViewProjection({
        position: [0, 0, 0],
        direction: [0, 0, 1],
        range: -1,
        outerRadians: Math.PI / 6
      })
    ).toThrow(/range/);
  });
});

describe('spot shadow PCF oracle', () => {
  const depthMap = new Float32Array(16).fill(0.5);
  depthMap[5] = 0.4;

  test('returns one for a fully visible receiver', () => {
    expect(
      sampleShadowDepthMapPcf({
        uv: [0.5, 0.5],
        depth: 0.3,
        depthMap,
        width: 4,
        height: 4,
        constantBias: 0.001,
        slopeBias: 0.01,
        normalDotLight: 1
      })
    ).toBe(1);
  });

  test('returns zero when every 3x3 tap is occluding', () => {
    const occluding = new Float32Array(16).fill(0.1);
    expect(
      sampleShadowDepthMapPcf({
        uv: [0.5, 0.5],
        depth: 0.5,
        depthMap: occluding,
        width: 4,
        height: 4,
        constantBias: 0.001,
        slopeBias: 0.01,
        normalDotLight: 0
      })
    ).toBe(0);
  });

  test('single-tap sampling matches the center texel visibility only', () => {
    const visibility = sampleShadowDepthMapPcf({
      uv: [0.5, 0.5],
      depth: 0.6,
      depthMap,
      width: 4,
      height: 4,
      constantBias: 0,
      slopeBias: 0,
      normalDotLight: 1,
      tapCount: 1
    });
    expect(visibility).toBe(0);
  });
});

describe('point shadow face selection oracle', () => {
  test('selects the correct face and uv center for dominant axis directions', () => {
    expect(pointShadowFaceIndexAndUv([1, 0, 0])).toMatchObject({ face: 0, uv: [0.5, 0.5] });
    expect(pointShadowFaceIndexAndUv([-1, 0, 0])).toMatchObject({ face: 1, uv: [0.5, 0.5] });
    expect(pointShadowFaceIndexAndUv([0, 1, 0])).toMatchObject({ face: 2, uv: [0.5, 0.5] });
    expect(pointShadowFaceIndexAndUv([0, -1, 0])).toMatchObject({ face: 3, uv: [0.5, 0.5] });
    expect(pointShadowFaceIndexAndUv([0, 0, 1])).toMatchObject({ face: 4, uv: [0.5, 0.5] });
    expect(pointShadowFaceIndexAndUv([0, 0, -1])).toMatchObject({ face: 5, uv: [0.5, 0.5] });
  });

  test('produces uv within the [0, 1] square for an arbitrary direction', () => {
    const result = pointShadowFaceIndexAndUv([0.3, -0.8, 0.5]);
    expect(result.face).toBeGreaterThanOrEqual(0);
    expect(result.face).toBeLessThanOrEqual(5);
    expect(result.uv[0]).toBeGreaterThanOrEqual(0);
    expect(result.uv[0]).toBeLessThanOrEqual(1);
    expect(result.uv[1]).toBeGreaterThanOrEqual(0);
    expect(result.uv[1]).toBeLessThanOrEqual(1);
  });

  test('rejects a zero direction', () => {
    expect(() => pointShadowFaceIndexAndUv([0, 0, 0])).toThrow(/non-zero/);
  });

  test('each face projection maps its forward direction to the shadow-map center', () => {
    const faces = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1]
    ];
    faces.forEach((forward, face) => {
      const vp = buildPointShadowFaceViewProjection({
        position: [0, 0, 0],
        face,
        near: 0.01,
        far: 10
      });
      const sample = projectPointToShadowSpace(vp, forward as [number, number, number]);
      expect(sample).toBeDefined();
      expect(sample!.uv[0]).toBeCloseTo(0.5, 5);
      expect(sample!.uv[1]).toBeCloseTo(0.5, 5);
    });
  });
});

describe('Shadow atlas tile mapping and sampling', () => {
  const tile: ShadowAtlasTileHandle = {
    key: 'spot:tile:1',
    generation: 1,
    x: 256,
    y: 512,
    width: 256,
    height: 256
  };

  test('mapShadowToAtlasTile maps normalized shadow space UV to atlas coordinates within tile', () => {
    const sample = { uv: [0.5, 0.5] as const, depth: 0.7 };
    const mapped = mapShadowToAtlasTile(sample, tile, 1024, 1024);
    expect(mapped).toBeDefined();
    // Centered at inner texel center
    expect(mapped!.atlasUv[0]).toBeCloseTo((256 + 0.5 + 0.5 * 255) / 1024);
    expect(mapped!.atlasUv[1]).toBeCloseTo((512 + 0.5 + 0.5 * 255) / 1024);
    expect(mapped!.depth).toBe(0.7);

    // Border inset texel centers
    const mappedBorder = mapShadowToAtlasTile(sample, tile, 1024, 1024, 4);
    expect(mappedBorder).toBeDefined();
    expect(mappedBorder!.atlasUv[0]).toBeCloseTo((260 + 0.5 + 0.5 * 247) / 1024);
    expect(mappedBorder!.atlasUv[1]).toBeCloseTo((516 + 0.5 + 0.5 * 247) / 1024);

    // Four corners map strictly to inner texels and never sample border or adjacent tiles
    const border = 4;
    const corners: [number, number][] = [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1]
    ];
    for (const [u, v] of corners) {
      const cornerMapped = mapShadowToAtlasTile(
        { uv: [u, v], depth: 0.5 },
        tile,
        1024,
        1024,
        border
      );
      expect(cornerMapped).toBeDefined();
      const texelX = Math.floor(cornerMapped!.atlasUv[0] * 1024);
      const texelY = Math.floor(cornerMapped!.atlasUv[1] * 1024);
      // Must be inside the inner region [tile.x + border, tile.x + tile.width - border - 1]
      expect(texelX).toBeGreaterThanOrEqual(tile.x + border);
      expect(texelX).toBeLessThanOrEqual(tile.x + tile.width - border - 1);
      expect(texelY).toBeGreaterThanOrEqual(tile.y + border);
      expect(texelY).toBeLessThanOrEqual(tile.y + tile.height - border - 1);
    }

    // Out of bounds samples return undefined
    expect(
      mapShadowToAtlasTile({ uv: [-0.1, 0.5] as const, depth: 0.5 }, tile, 1024, 1024)
    ).toBeUndefined();
    expect(
      mapShadowToAtlasTile({ uv: [0.5, 1.1] as const, depth: 0.5 }, tile, 1024, 1024)
    ).toBeUndefined();

    // Invalid dimensions fail fast
    expect(() => mapShadowToAtlasTile(sample, tile, 0, 1024)).toThrow(/positive safe integer/);
    expect(() => mapShadowToAtlasTile(sample, { ...tile, width: 2000 }, 1024, 1024)).toThrow(
      /outside the atlas boundary/
    );
  });

  test('sampleSpotShadowAtlas evaluates spot light receiver visibility through atlas depth map', () => {
    const viewProjection = buildSpotShadowViewProjection({
      position: [0, 5, 0],
      direction: [0, -1, 0],
      range: 10,
      outerRadians: Math.PI / 6,
      near: 0.1,
      far: 10
    });

    const atlasTile: ShadowAtlasTileHandle = {
      key: 'spot:tile:main',
      generation: 1,
      x: 0,
      y: 0,
      width: 16,
      height: 16
    };

    // Depth map with caster plane at normalized depth 0.985 (between dist 3: 0.976 and dist 7: 0.996)
    const depthMap = new Float32Array(16 * 16).fill(0.985);

    // Point in front of caster (closer to light, smaller depth) -> fully lit (1.0)
    const litVisibility = sampleSpotShadowAtlas({
      worldPosition: [0, 2, 0],
      viewProjection,
      tile: atlasTile,
      atlasWidth: 16,
      atlasHeight: 16,
      depthMap,
      constantBias: 0.001,
      slopeBias: 0.001,
      normalDotLight: 1.0,
      tapCount: 1
    });
    expect(litVisibility).toBe(1.0);

    // Point behind caster (further from light, larger depth) -> shadowed (0.0)
    const shadowedVisibility = sampleSpotShadowAtlas({
      worldPosition: [0, -2, 0],
      viewProjection,
      tile: atlasTile,
      atlasWidth: 16,
      atlasHeight: 16,
      depthMap,
      constantBias: 0.001,
      slopeBias: 0.001,
      normalDotLight: 1.0,
      tapCount: 1
    });
    expect(shadowedVisibility).toBe(0.0);

    // Point outside the spot cone -> unshadowed (1.0)
    const outsideVisibility = sampleSpotShadowAtlas({
      worldPosition: [50, 2, 0],
      viewProjection,
      tile: atlasTile,
      atlasWidth: 16,
      atlasHeight: 16,
      depthMap,
      constantBias: 0.001,
      slopeBias: 0.001,
      normalDotLight: 1.0,
      tapCount: 1
    });
    expect(outsideVisibility).toBe(1.0);
  });
});
