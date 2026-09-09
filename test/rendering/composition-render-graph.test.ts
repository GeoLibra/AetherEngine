import { describe, expect, it, vi } from 'vitest';
import {
  compileCompositionPlan,
  lowerCompositionPlan,
  type CompositionSlotResources,
  type RestrictedPassContext
} from '../../src';
import { RenderGraphExecutor } from '../../src/render-graph';
import { NullDevice } from '../../src/rhi/null/device';
import { NullSurface } from '../../src/rhi/null/surface';

describe('CompositionPlan RenderGraph consumer', () => {
  it('lowers multiple views and surfaces into one graph with one owner per target', () => {
    const composition = compileCompositionPlan({
      id: 'frame',
      revision: 1,
      policyHash: 'policy',
      surfaces: [
        { id: 'a', generation: 1, width: 4, height: 4, format: 'rgba8unorm' },
        { id: 'b', generation: 2, width: 8, height: 8, format: 'rgba8unorm' }
      ],
      slots: [
        {
          id: 'base',
          viewId: 'v1',
          targetId: 'a',
          viewportPixels: { x: 0, y: 0, width: 4, height: 4 },
          colorLoad: 'clear',
          depthLoad: 'none',
          stores: { color: true, depth: false },
          order: 0
        },
        {
          id: 'overlay',
          viewId: 'v2',
          targetId: 'a',
          viewportPixels: { x: 0, y: 0, width: 4, height: 4 },
          colorLoad: 'load',
          depthLoad: 'none',
          stores: { color: true, depth: false },
          order: 1,
          present: true
        },
        {
          id: 'preview',
          viewId: 'v3',
          targetId: 'b',
          viewportPixels: { x: 0, y: 0, width: 8, height: 8 },
          colorLoad: 'clear',
          depthLoad: 'none',
          stores: { color: true, depth: false },
          order: 0,
          present: true
        }
      ]
    });
    const recorder = () => ({ record: vi.fn() });
    const lowered = lowerCompositionPlan(
      composition,
      new Map([
        ['base', recorder()],
        ['overlay', recorder()],
        ['preview', recorder()]
      ])
    );
    expect(lowered.plan.snapshot.passes.map(({ id }) => id)).toEqual([
      'composition:frame:base',
      'composition:frame:overlay',
      'composition:frame:preview'
    ]);
    expect(lowered.plan.snapshot.terminals.map(({ kind }) => kind)).toEqual(['present', 'present']);
    expect(lowered.plan.compiled.order).toHaveLength(3);
    expect([...lowered.surfaceFrameTokens]).toEqual([
      ['a', 'a'],
      ['b', 'b']
    ]);
  });

  it('fails before graph publication when a slot recorder is absent', () => {
    const composition = compileCompositionPlan({
      id: 'frame',
      revision: 1,
      policyHash: 'policy',
      surfaces: [{ id: 'a', generation: 1, width: 4, height: 4, format: 'rgba8unorm' }],
      slots: [
        {
          id: 'base',
          viewId: 'v',
          targetId: 'a',
          viewportPixels: { x: 0, y: 0, width: 4, height: 4 },
          colorLoad: 'clear',
          depthLoad: 'none',
          stores: { color: true, depth: false },
          order: 0,
          present: true
        }
      ]
    });
    expect(() => lowerCompositionPlan(composition, new Map())).toThrow('has no recorder');
  });

  it('executes two surface lineages through one executor submission', () => {
    const device = new NullDevice();
    const makeSurface = (name: string, width: number, height: number) => {
      const surface = new NullSurface({ id: Symbol(name), kind: 'offscreen' });
      surface.configure(
        device,
        {
          format: 'rgba8unorm',
          colorSpace: 'srgb',
          alphaMode: 'opaque',
          width,
          height,
          presentMode: 'fifo'
        },
        1
      );
      return surface;
    };
    const first = makeSurface('first', 4, 4);
    const second = makeSurface('second', 8, 8);
    const composition = compileCompositionPlan({
      id: 'frame',
      revision: 1,
      policyHash: 'policy',
      surfaces: [
        { id: 'a', generation: first.generation, width: 4, height: 4, format: 'rgba8unorm' },
        { id: 'b', generation: second.generation, width: 8, height: 8, format: 'rgba8unorm' }
      ],
      slots: [
        {
          id: 'a-slot',
          viewId: 'a-view',
          targetId: 'a',
          viewportPixels: { x: 0, y: 0, width: 4, height: 4 },
          colorLoad: 'clear',
          depthLoad: 'none',
          stores: { color: true, depth: false },
          order: 0,
          present: true
        },
        {
          id: 'b-slot',
          viewId: 'b-view',
          targetId: 'b',
          viewportPixels: { x: 0, y: 0, width: 8, height: 8 },
          colorLoad: 'clear',
          depthLoad: 'none',
          stores: { color: true, depth: false },
          order: 0,
          present: true
        }
      ]
    });
    const rasterRecorder = {
      record(
        context: RestrictedPassContext,
        resources: CompositionSlotResources
      ) {
        context
          .beginRaster({
            colorAttachments: [{ texture: resources.color, loadOp: 'clear', storeOp: 'store' }]
          })
          .end();
      }
    };
    const lowered = lowerCompositionPlan(
      composition,
      new Map([
        ['a-slot', rasterRecorder],
        ['b-slot', rasterRecorder]
      ])
    );
    const execution = new RenderGraphExecutor().execute(lowered.plan, {
      device,
      surfaces: new Map([
        ['a', first],
        ['b', second]
      ])
    });
    expect(execution.commandStats.renderPasses).toBe(2);
    expect(execution.submission.id).toBeGreaterThan(0);
    expect(first.acquiredFrameCount).toBe(1);
    expect(second.acquiredFrameCount).toBe(1);
  });
});
