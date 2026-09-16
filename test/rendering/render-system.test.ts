import { describe, expect, test } from 'vitest';
import { RenderGraphBuilder } from '../../src/render-graph/builder';
import {
  RenderSystemRegistry,
  compileRenderSystems,
  renderSystemToken,
  type RenderSystemDescriptor
} from '../../src/rendering/systems';
import { compileRenderGraph, RenderGraphCycleError } from '../../src/render-graph/compiler';
import { createRenderGraphDebugIR } from '../../src/render-graph/debug';
import type { BufferHandle, BufferDescriptor } from '../../src/render-graph/types';
import type {
  RenderEntityView,
  RenderQuerySnapshot,
  RenderQuerySpec,
  RenderEntityId
} from '../../src/rendering/world';
import type { RenderView } from '../../src/rendering/visibility';

const BUFFER: BufferDescriptor = Object.freeze({
  size: 16,
  usage: Object.freeze(['copy-dst', 'copy-src'] as const)
});

const query: RenderQuerySpec<string> = Object.freeze({
  id: 'renderable',
  reads: Object.freeze([]),
  project: () => 'item'
});

const querySnapshot: RenderQuerySnapshot<string> = Object.freeze({
  queryId: 'renderable',
  renderRevision: 4,
  items: Object.freeze(['item'])
});

function view(id: string): RenderView {
  return Object.freeze({
    id,
    camera: 1 as RenderEntityId,
    surface: id,
    viewport: Object.freeze({ x: 0, y: 0, width: 16, height: 16 }),
    layerMask: 1,
    featurePolicyKey: 'test',
    historyKey: `${id}/history`
  });
}

describe('RenderSystem facade', () => {
  test('rejects the legacy register alias method on RenderSystemRegistry', () => {
    const registry = new RenderSystemRegistry();
    // @ts-expect-error register alias was removed in favor of add
    expect(registry.register).toBeUndefined();
  });

  test('reports semantic cycles through the sole RenderGraph compiler', () => {
    const registry = new RenderSystemRegistry();
    registry.add({
      id: 'first',
      kind: 'compute',
      scope: 'global',
      after: [renderSystemToken('second')],
      setup(pass) {
        pass.sideEffect('first');
        return {};
      },
      run() {}
    });
    registry.add({
      id: 'second',
      kind: 'compute',
      scope: 'global',
      after: [renderSystemToken('first')],
      setup(pass) {
        pass.sideEffect('second');
        return {};
      },
      run() {}
    });

    expect(() => compileRenderSystems(registry, { views: [] })).toThrow(RenderGraphCycleError);
  });

  test('rejects undeclared query fields, mismatched snapshots, and mutable projected items', () => {
    const declared = Object.freeze({ id: Symbol('declared'), name: 'declared' });
    const undeclared = Object.freeze({ id: Symbol('undeclared'), name: 'undeclared' });
    const guardedQuery: RenderQuerySpec<unknown> = Object.freeze({
      id: 'guarded',
      reads: Object.freeze([declared]),
      project: (entity: RenderEntityView) => entity.get(undeclared)
    });
    const registry = new RenderSystemRegistry();
    registry.add({
      id: 'guarded',
      kind: 'compute',
      scope: 'global',
      query: guardedQuery,
      setup(pass) {
        pass.sideEffect('guarded');
        return undefined;
      },
      run() {}
    });
    expect(() =>
      compileRenderSystems(registry, {
        views: [],
        snapshots: {
          query(spec) {
            spec.project({
              entity: 1 as RenderEntityId,
              get: <T>() => 'secret' as T
            });
            return Object.freeze({
              queryId: spec.id,
              renderRevision: 1,
              items: Object.freeze([])
            });
          }
        }
      })
    ).toThrow(/undeclared field/i);

    expect(() =>
      compileRenderSystems(registry, {
        views: [],
        snapshots: {
          query: () =>
            Object.freeze({
              queryId: 'wrong',
              renderRevision: 1,
              items: Object.freeze([])
            })
        }
      })
    ).toThrow(/snapshot.*query/i);

    expect(() =>
      compileRenderSystems(registry, {
        views: [],
        snapshots: {
          query: () =>
            Object.freeze({
              queryId: 'guarded',
              renderRevision: 1,
              items: Object.freeze([{}])
            })
        }
      })
    ).toThrow(/mutable query projection item/i);

    const hidden = Symbol('hidden');
    const mutableNested = {};
    const frozenWithHiddenMutable = Object.freeze(
      Object.defineProperty({}, hidden, { value: mutableNested, enumerable: false })
    );
    expect(() =>
      compileRenderSystems(registry, {
        views: [],
        snapshots: {
          query: () =>
            Object.freeze({
              queryId: 'guarded',
              renderRevision: 1,
              items: Object.freeze([frozenWithHiddenMutable])
            })
        }
      })
    ).toThrow(/mutable query projection item/i);
  });
  test('lowers before constraints into the same graph semantic edge', () => {
    const registry = new RenderSystemRegistry();
    registry.add({
      id: 'later',
      kind: 'compute',
      scope: 'global',
      setup(pass) {
        pass.sideEffect('later');
        return {};
      },
      run() {}
    });
    registry.add({
      id: 'earlier',
      kind: 'compute',
      scope: 'global',
      before: [renderSystemToken('later')],
      setup(pass) {
        pass.sideEffect('earlier');
        return {};
      },
      run() {}
    });

    const compiled = compileRenderSystems(registry, { views: [] }).plan.compiled;

    expect(compiled.retainedPasses.map((pass) => pass.id)).toEqual([
      'earlier@global',
      'later@global'
    ]);
    expect(compiled.edges).toContainEqual({
      kind: 'semantic',
      fromPassId: 1,
      toPassId: 0
    });
  });

  test('lowers facade declarations to the direct graph order, edges, culling, and Debug IR', () => {
    let directOutput: BufferHandle | undefined;
    const direct = new RenderGraphBuilder();
    const directShade = direct.addCopyPass({
      id: 'shade@global',
      setup(pass) {
        directOutput = pass.writeBuffer(pass.createBuffer(BUFFER), 'copy-dst');
        return directOutput;
      },
      run() {}
    });
    direct.addCopyPass({
      id: 'finish@global',
      setup(pass) {
        pass.after(directShade);
        pass.readBuffer(directOutput!, 'copy-src');
        pass.sideEffect('submit output');
        return {};
      },
      run() {}
    });
    direct.addCopyPass({
      id: 'discarded@global',
      setup(pass) {
        return pass.writeBuffer(pass.createBuffer(BUFFER), 'copy-dst');
      },
      run() {}
    });
    const directSnapshot = direct.build();
    const directCompiled = compileRenderGraph(directSnapshot);

    let facadeOutput: BufferHandle | undefined;
    const registry = new RenderSystemRegistry();
    registry.add({
      id: 'shade',
      kind: 'copy',
      scope: 'global',
      setup(pass) {
        facadeOutput = pass.writeBuffer(pass.createBuffer(BUFFER), 'copy-dst');
        return facadeOutput;
      },
      run() {}
    });
    registry.add({
      id: 'finish',
      kind: 'copy',
      scope: 'global',
      after: [renderSystemToken('shade')],
      query,
      setup(pass) {
        pass.readBuffer(facadeOutput!, 'copy-src');
        pass.sideEffect('submit output');
        return {};
      },
      run() {}
    });
    registry.add({
      id: 'discarded',
      kind: 'copy',
      scope: 'global',
      setup(pass) {
        return pass.writeBuffer(pass.createBuffer(BUFFER), 'copy-dst');
      },
      run() {}
    });

    const facade = compileRenderSystems(registry, {
      views: [],
      snapshots: { query: () => querySnapshot }
    });

    expect(facade.plan.compiled.order).toEqual(directCompiled.order);
    expect(facade.plan.compiled.edges).toEqual(directCompiled.edges);
    expect(facade.plan.compiled.culledPasses).toEqual(directCompiled.culledPasses);
    expect(facade.debug).toEqual(createRenderGraphDebugIR(directSnapshot, directCompiled));
    expect(facade.internalNodes.map((node) => node.kind)).toEqual(['prelude', 'submission']);
    expect(facade.plan.schedule.map((step) => step.kind)).toEqual([
      'prelude',
      'pass',
      'pass',
      'submission'
    ]);
    expect(facade.debug.schedule).toEqual(facade.plan.schedule);
    expect(facade.internalNodes[0]).toBe(facade.plan.schedule[0]);
    expect(facade.internalNodes[1]).toBe(facade.plan.schedule.at(-1));
  });

  test('instantiates globals once, gives views stable ids, and reuses immutable query snapshots', () => {
    const seen: RenderQuerySnapshot<string>[] = [];
    const registry = new RenderSystemRegistry();
    const retained = (descriptor: RenderSystemDescriptor<{}, string>) => registry.add(descriptor);
    retained({
      id: 'global',
      kind: 'compute',
      scope: 'global',
      query,
      setup(pass) {
        pass.sideEffect('global work');
        return {};
      },
      run(_context, _resources, items) {
        seen.push(items);
      }
    });
    retained({
      id: 'per-view',
      kind: 'compute',
      scope: 'per-view',
      query,
      setup(pass) {
        pass.sideEffect('view work');
        return {};
      },
      run(_context, _resources, items) {
        seen.push(items);
      }
    });
    let queryCalls = 0;
    const options = {
      views: [view('main'), view('preview')],
      snapshots: {
        query: () => {
          queryCalls++;
          return querySnapshot;
        }
      }
    };

    const first = compileRenderSystems(registry, options);
    const second = compileRenderSystems(registry, options);

    expect(first.instances.map((instance) => instance.id)).toEqual([
      'global@global',
      'per-view@view:main',
      'per-view@view:preview'
    ]);
    expect(second.instances.map((instance) => instance.id)).toEqual(
      first.instances.map((instance) => instance.id)
    );
    expect(queryCalls).toBe(2);
    expect(Object.isFrozen(first.instances[0]?.query.items)).toBe(true);
    for (const pass of first.plan.compiled.retainedPasses) pass.run({} as never);
    expect(seen).toEqual([querySnapshot, querySnapshot, querySnapshot]);
  });

  test('lowers CopyRenderSystemDescriptor to a typed copy pass', () => {
    const registry = new RenderSystemRegistry();
    registry.add({
      id: 'copy-sys',
      kind: 'copy',
      scope: 'global',
      setup(pass) {
        pass.sideEffect('copy work');
        return {};
      },
      run() {}
    });
    const result = compileRenderSystems(registry, {
      views: [],
      snapshots: { query: () => querySnapshot }
    });
    expect(result.plan.compiled.retainedPasses[0]?.passKind).toBe('copy');
  });

  test('rejects an unsupported system kind during compilation', () => {
    const registry = new RenderSystemRegistry();
    registry.add({
      id: 'invalid-kind',
      kind: 'invalid' as any,
      scope: 'global',
      setup: () => ({}),
      run: () => {}
    });
    expect(() =>
      compileRenderSystems(registry, {
        views: [],
        snapshots: { query: () => querySnapshot }
      })
    ).toThrow(/Unsupported render system kind/i);
  });
});
