import { describe, expect, test } from 'vitest';
import { createBufferLayoutManifest, type ShaderStructTypeIR } from '../../src/shader';
import {
  RenderGraphBuilder,
  RenderGraphExecutor,
  compileRenderGraph,
  createRenderGraphExecutionPlan,
  type RestrictedPassContext
} from '../../src/render-graph';
import { NullDevice } from '../../src/rhi/null/device';
import {
  LIGHT_FLAG_CASTS_SHADOW,
  LIGHT_FLAG_ENABLED,
  ShadowAtlasAllocator,
  buildCpuLightLists,
  createShadowCacheKey,
  declareShadowDepthPasses,
  selectShadowRequests,
  shadowRequestKey,
  validatePreparedLight,
  writeReflectedLightBuffer,
  type PreparedLight,
  type RenderEntityId,
  type ShadowRequest
} from '../../src/rendering';

const entity = (value: number) => value as RenderEntityId;

const directional = (id: number, overrides: Partial<PreparedLight> = {}): PreparedLight =>
  ({
    entity: entity(id),
    payloadVersion: 1,
    kind: 'directional',
    direction: [0, -1, 0],
    illuminanceLux: 100_000,
    colorLinear: [1, 0.9, 0.8],
    enabled: true,
    layerMask: 1,
    castsShadow: true,
    ...overrides
  }) as PreparedLight;

const point = (id: number, x: number, overrides: Partial<PreparedLight> = {}): PreparedLight =>
  ({
    entity: entity(id),
    payloadVersion: 1,
    kind: 'point',
    position: [x, 0, 0],
    luminousIntensityCandela: 500,
    range: 2,
    colorLinear: [1, 1, 1],
    enabled: true,
    layerMask: 1,
    castsShadow: false,
    ...overrides
  }) as PreparedLight;

const spot = (id: number, x: number): PreparedLight => ({
  entity: entity(id),
  payloadVersion: 2,
  kind: 'spot',
  position: [x, 0, 0],
  direction: [0, 0, -2],
  luminousIntensityCandela: 250,
  range: 3,
  innerRadians: 0.2,
  outerRadians: 0.4,
  colorLinear: [0.5, 0.75, 1],
  enabled: true,
  layerMask: 1,
  castsShadow: true
});

describe('physical light preparation', () => {
  test('validates physical units, directions, colors, and spot angles', () => {
    expect(() => validatePreparedLight(directional(1))).not.toThrow();
    expect(() => validatePreparedLight(point(2, 0))).not.toThrow();
    expect(() => validatePreparedLight(spot(3, 0))).not.toThrow();
    expect(() => validatePreparedLight(directional(1, { direction: [0, 0, 0] }))).toThrow(
      /non-zero/
    );
    expect(() => validatePreparedLight(point(2, 0, { range: 0 }))).toThrow(/range/);
    expect(() =>
      validatePreparedLight({
        ...(spot(3, 0) as Extract<PreparedLight, { readonly kind: 'spot' }>),
        innerRadians: 0.5,
        outerRadians: 0.4
      })
    ).toThrow(/angles/);
    expect(() =>
      writeReflectedLightBuffer(lightBufferManifest(2), [point(2, 0), point(2, 1)])
    ).toThrow(/duplicate/i);
  });

  test('packs a stable reflected byte layout with real u32 header and flags', () => {
    const manifest = lightBufferManifest(2);
    const result = writeReflectedLightBuffer(manifest, [directional(9), point(2, 1)]);
    const view = new DataView(result.bytes);
    const field = (path: string) => manifest.fields.find((entry) => entry.path === path)!;

    expect(result.lights.map((light) => light.entity)).toEqual([entity(2), entity(9)]);
    expect(view.getUint32(field('count').offset, true)).toBe(2);
    expect(view.getUint32(field('lights[0].kind').offset, true)).toBe(1);
    expect(view.getUint32(field('lights[1].kind').offset, true)).toBe(0);
    expect(view.getUint32(field('lights[1].flags').offset, true)).toBe(
      LIGHT_FLAG_ENABLED | LIGHT_FLAG_CASTS_SHADOW
    );
    expect(view.getUint32(field('lights[1].layerMask').offset, true)).toBe(1);
    expect(view.getFloat32(field('lights[1].intensity').offset, true)).toBe(100_000);
  });
});

describe('CPU light-list fallback', () => {
  test('separates directional lights and deterministically truncates local lists', () => {
    const result = buildCpuLightLists({
      viewLayerMask: 1,
      lights: [directional(10), spot(7, 1), point(2, 0), point(20, 50)],
      receivers: [
        {
          renderEntity: entity(5),
          layerMask: 1,
          bounds: { kind: 'sphere', center: [0, 0, 0], radius: 0.25 }
        },
        {
          renderEntity: entity(1),
          layerMask: 1,
          bounds: { kind: 'aabb', min: [49, -1, -1], max: [51, 1, 1] }
        }
      ],
      capacity: { maxDirectionalLights: 1, maxLightsPerReceiver: 1, maxLightIndices: 2 }
    });

    expect(result.orderedLights.map((light) => light.entity)).toEqual([
      entity(2),
      entity(7),
      entity(10),
      entity(20)
    ]);
    expect(result.globalDirectionalLightIndices).toEqual([2]);
    expect(result.headers).toEqual([
      { receiver: entity(1), offset: 0, count: 1, overflowed: false },
      { receiver: entity(5), offset: 1, count: 1, overflowed: true }
    ]);
    expect(result.lightIndices).toEqual([3, 0]);
    expect(result).toMatchObject({
      source: 'cpu-list',
      fallback: 'deterministic-truncate',
      overflowed: true,
      counters: { emittedIndices: 2, overflowedReceivers: 1, truncatedIndices: 1 }
    });
  });

  test('detaches ordered light snapshots from caller-owned light records', () => {
    const nestedExtra = { callerOwned: true };
    const light = {
      ...point(1, 0),
      nestedExtra
    } as Extract<PreparedLight, { readonly kind: 'point' }> & { nestedExtra: object };
    const directionalLight = {
      ...directional(2),
      nestedExtra
    } as Extract<PreparedLight, { readonly kind: 'directional' }> & { nestedExtra: object };
    const spotLight = {
      ...spot(3, 0),
      nestedExtra
    } as Extract<PreparedLight, { readonly kind: 'spot' }> & { nestedExtra: object };
    const result = buildCpuLightLists({
      viewLayerMask: 1,
      lights: [light, directionalLight, spotLight],
      receivers: [],
      capacity: { maxDirectionalLights: 1, maxLightsPerReceiver: 1, maxLightIndices: 1 }
    });

    (light.position as [number, number, number])[0] = 99;
    (light.colorLinear as [number, number, number])[0] = 0;

    expect(result.orderedLights[0]).toMatchObject({ position: [0, 0, 0], colorLinear: [1, 1, 1] });
    expect(result.orderedLights.every((published) => !('nestedExtra' in published))).toBe(true);
    expect(
      result.orderedLights.find((published) => published.kind === 'directional')
    ).toMatchObject({
      direction: [0, -1, 0]
    });
    expect(result.orderedLights.find((published) => published.kind === 'spot')).toMatchObject({
      position: [0, 0, 0],
      direction: [0, 0, -2]
    });
  });

  test('filters disabled and layer-mismatched light/receiver state observably', () => {
    const result = buildCpuLightLists({
      viewLayerMask: 1,
      lights: [point(1, 0, { enabled: false }), point(2, 0, { layerMask: 2 })],
      receivers: [
        { renderEntity: entity(1), enabled: false, layerMask: 1, bounds: sphereAt(0) },
        { renderEntity: entity(2), layerMask: 2, bounds: sphereAt(0) }
      ],
      capacity: { maxDirectionalLights: 1, maxLightsPerReceiver: 4, maxLightIndices: 8 }
    });
    expect(result.headers).toEqual([]);
    expect(result.counters).toMatchObject({
      disabledLights: 1,
      layerRejectedLights: 1,
      disabledReceivers: 1,
      layerRejectedReceivers: 1
    });
    expect(() =>
      buildCpuLightLists({
        viewLayerMask: 1,
        lights: [],
        receivers: [
          {
            renderEntity: entity(4),
            layerMask: 1,
            bounds: { kind: 'sphere', center: [Number.NaN, 0, 0], radius: 1 }
          }
        ],
        capacity: { maxDirectionalLights: 1, maxLightsPerReceiver: 1, maxLightIndices: 1 }
      })
    ).toThrow(/sphere/i);
  });
});

describe('shadow requests, atlas, cache, and graph', () => {
  const request = (id: number, importance: number, resolutionClass = 32): ShadowRequest => ({
    lightEntity: entity(id),
    viewId: 'main',
    kind: 'directional-cascade',
    subresourceIndex: id,
    resolutionClass,
    importance,
    casterRevision: 4
  });

  test('admits requests by stable importance under count and texel budgets', () => {
    const selected = selectShadowRequests([request(3, 1), request(1, 4), request(2, 2, 64)], {
      maxRequests: 2,
      maxTexels: 32 * 32 * 2
    });
    expect(selected.accepted.map((entry) => entry.lightEntity)).toEqual([entity(1), entity(3)]);
    expect(selected.rejected).toEqual([
      expect.objectContaining({
        request: expect.objectContaining({ lightEntity: entity(2) }),
        reason: 'texel-capacity'
      })
    ]);
    expect(selected.usedTexels).toBe(2048);
  });

  test('detaches selected shadow requests from caller-owned records', () => {
    const nestedExtra = { callerOwned: true };
    const accepted = { ...request(1, 2), nestedExtra } as ShadowRequest & { nestedExtra: object };
    const rejected = { ...request(2, 1, 64), nestedExtra } as ShadowRequest & {
      nestedExtra: object;
    };
    const selected = selectShadowRequests([accepted, rejected], {
      maxRequests: 1,
      maxTexels: 32 * 32
    });

    (accepted as { importance: number }).importance = 99;
    (rejected as { resolutionClass: number }).resolutionClass = 1;

    expect(selected.accepted[0]).toMatchObject({ importance: 2, resolutionClass: 32 });
    expect(selected.rejected[0]?.request).toMatchObject({ importance: 1, resolutionClass: 64 });
    expect('nestedExtra' in selected.accepted[0]!).toBe(false);
    expect('nestedExtra' in selected.rejected[0]!.request).toBe(false);
  });

  test('invalidates generation-bearing atlas tiles on resize and keys every cache revision', () => {
    const atlas = new ShadowAtlasAllocator({ width: 64, height: 64 });
    const first = atlas.allocate('first', 32)!;
    expect(atlas.allocate('first', 32)).toBe(first);
    expect(atlas.metrics()).toMatchObject({ allocatedTiles: 1, occupancy: 0.25 });
    const key = createShadowCacheKey({
      request: request(1, 1),
      lightTransformRevision: 2,
      projectionRevision: 3,
      materialShadowVariant: 'pbr-shadow@1',
      atlasGeneration: atlas.generation
    });
    expect(JSON.parse(key)).toEqual([expect.any(String), 4, 32, 2, 3, 'pbr-shadow@1', 1]);
    expect(shadowRequestKey(request(1, 1, 32))).toBe(shadowRequestKey(request(1, 1, 64)));
    expect(
      createShadowCacheKey({
        request: request(1, 1, 64),
        lightTransformRevision: 2,
        projectionRevision: 3,
        materialShadowVariant: 'pbr-shadow@1',
        atlasGeneration: atlas.generation
      })
    ).not.toBe(key);
    atlas.resize(128, 64);
    expect(atlas.isValid(first)).toBe(false);
    expect(atlas.generation).toBe(2);
  });

  test('reclaims stacked release holes and rolls back a failed tile resize', () => {
    const atlas = new ShadowAtlasAllocator({ width: 64, height: 64 });
    const first = atlas.allocate('first', 32)!;
    const second = atlas.allocate('second', 32)!;
    atlas.allocate('third', 32);
    atlas.allocate('fourth', 32);
    expect(atlas.release('first')).toBe(true);
    expect(atlas.allocate('replacement', 32)).toMatchObject({ x: first.x, y: first.y });
    expect(atlas.allocate('second', 64)).toBeUndefined();
    expect(atlas.isValid(second)).toBe(true);
  });

  test('invalidates every prior handle when explicit compaction relocates the atlas', () => {
    const atlas = new ShadowAtlasAllocator({ width: 128, height: 64 });
    const first = atlas.allocate('first', 32)!;
    const second = atlas.allocate('second', 64)!;
    const compacted = atlas.compact()!;

    expect(compacted.generation).toBe(2);
    expect(compacted.relocations.map(({ key }) => key).sort()).toEqual(['first', 'second']);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(compacted.relocations[0])).toBe(true);
    expect(() => Object.assign(compacted.relocations[0]!, { key: 'rewritten' })).toThrow();
    expect(atlas.isValid(first)).toBe(false);
    expect(atlas.isValid(second)).toBe(false);
    for (const relocation of compacted.relocations)
      expect(atlas.isValid(relocation.next)).toBe(true);
  });

  test('compiles and executes each accepted shadow write as a distinct depth subresource', () => {
    const graph = new RenderGraphBuilder();
    const recorded: string[] = [];
    const declared = declareShadowDepthPasses(graph, [request(1, 3), request(2, 2)], {
      record(context, shadowPass) {
        recorded.push(shadowRequestKey(shadowPass.request));
        context
          .beginRaster({
            label: `shadow-layer-${shadowPass.layer}`,
            colorAttachments: [],
            depthStencilAttachment: {
              texture: shadowPass.texture,
              range: shadowPass.range,
              depthLoadOp: 'clear',
              depthStoreOp: 'store',
              depthClearValue: 1
            }
          })
          .end();
      }
    });
    const mutableLayers = declared.layerByRequestKey as unknown as Map<string, number>;
    try {
      mutableLayers.set(shadowRequestKey(request(1, 3)), 99);
    } catch {
      // The public facade rejects mutation attempted through an unsound cast.
    }
    expect(Object.isFrozen(declared.layerByRequestKey)).toBe(true);
    expect(Reflect.ownKeys(declared.layerByRequestKey)).toEqual([]);
    expect(declared.layerByRequestKey.get(shadowRequestKey(request(1, 3)))).toBe(0);
    graph.addPass({
      id: 'shadow-consumer',
      setup(pass) {
        const texture = pass.readTexture(declared.texture!, 'sampled');
        pass.sideEffect('verify sampled shadow output');
        return { texture };
      },
      run(context: RestrictedPassContext, resources) {
        context.texture(resources.texture, 'sampled');
      }
    });
    const snapshot = graph.build();
    const compiled = compileRenderGraph(snapshot);
    const plan = createRenderGraphExecutionPlan(snapshot, compiled);
    const execution = new RenderGraphExecutor().execute(plan, { device: new NullDevice() });

    expect(declared.texture?.version).toBe(2);
    expect(snapshot.passes).toHaveLength(3);
    expect(snapshot.passes.slice(0, 2).map((pass) => pass.accesses[0]?.range)).toEqual([
      expect.objectContaining({ baseArrayLayer: 0, arrayLayerCount: 1, aspect: 'depth-only' }),
      expect.objectContaining({ baseArrayLayer: 1, arrayLayerCount: 1, aspect: 'depth-only' })
    ]);
    expect(compiled.culledPasses).toEqual([]);
    expect(compiled.edges.filter((edge) => edge.kind === 'raw')).toHaveLength(2);
    expect(recorded).toEqual([shadowRequestKey(request(1, 3)), shadowRequestKey(request(2, 2))]);
    expect(execution.commandStats.renderPasses).toBe(2);
  });
});

function sphereAt(x: number) {
  return { kind: 'sphere' as const, center: [x, 0, 0] as const, radius: 1 };
}

function lightBufferManifest(count: number) {
  const Light: ShaderStructTypeIR = {
    kind: 'struct',
    name: 'PreparedLightRecord',
    fields: [
      { name: 'position', type: 'vec3<f32>' },
      { name: 'kind', type: 'u32' },
      { name: 'direction', type: 'vec3<f32>' },
      { name: 'range', type: 'f32' },
      { name: 'colorLinear', type: 'vec3<f32>' },
      { name: 'intensity', type: 'f32' },
      { name: 'spotAngles', type: 'vec2<f32>' },
      { name: 'flags', type: 'u32' },
      { name: 'layerMask', type: 'u32' }
    ]
  };
  const Buffer: ShaderStructTypeIR = {
    kind: 'struct',
    name: 'PreparedLightBuffer',
    fields: [
      { name: 'count', type: 'u32' },
      { name: 'lights', type: `array<PreparedLightRecord, ${count}>` }
    ]
  };
  return createBufferLayoutManifest('lights', Buffer, [Light, Buffer], 1, {
    addressSpace: 'storage',
    target: 'wgsl'
  });
}
