import { describe, expect, test } from 'vitest';
import { RenderGraphBuilder } from '../../src/render-graph/builder';
import { compileRenderGraph } from '../../src/render-graph/compiler';
import {
  RenderGraphExecutor,
  createRenderGraphExecutionPlan
} from '../../src/render-graph/executor';
import type { RenderGraphExecutionPlan } from '../../src/render-graph/types';
import { NullDevice } from '../../src/rhi/null/device';

function planWithTwoPasses(calls: string[]): RenderGraphExecutionPlan {
  const graph = new RenderGraphBuilder();
  for (const id of ['first', 'second']) {
    graph.addCopyPass({
      id,
      setup(pass) {
        pass.sideEffect(id);
        return {};
      },
      run() {
        calls.push(id);
      }
    });
  }
  const snapshot = graph.build();
  return createRenderGraphExecutionPlan(snapshot, compileRenderGraph(snapshot));
}

describe('RenderGraphExecutionPlan validation', () => {
  test('rejects forged compiled data passed through the exported plan factory', () => {
    const calls: string[] = [];
    const canonical = planWithTwoPasses(calls);
    const forged = Object.freeze({
      ...canonical.compiled,
      retainedPasses: Object.freeze([]),
      order: Object.freeze([]),
      edges: Object.freeze([]),
      rootPassIds: Object.freeze([])
    });

    expect(() => createRenderGraphExecutionPlan(canonical.snapshot, forged)).toThrow(
      /compiled graph provenance/i
    );
  });

  test('rejects a compiler result paired with a cloned snapshot sharing its graph id', () => {
    const canonical = planWithTwoPasses([]);
    const clonedSnapshot = Object.freeze({
      ...canonical.snapshot,
      resources: Object.freeze([...canonical.snapshot.resources])
    });

    expect(() => createRenderGraphExecutionPlan(clonedSnapshot, canonical.compiled)).toThrow(
      /compiled graph provenance/i
    );
  });

  test.each([
    {
      name: 'a structurally consistent forged empty compiled plan',
      mutate(plan: RenderGraphExecutionPlan) {
        return Object.freeze({
          ...plan,
          compiled: Object.freeze({
            ...plan.compiled,
            retainedPasses: Object.freeze([]),
            order: Object.freeze([]),
            edges: Object.freeze([]),
            rootPassIds: Object.freeze([])
          }),
          schedule: Object.freeze([{ kind: 'prelude' as const }, { kind: 'submission' as const }])
        });
      }
    },
    {
      name: 'a sparse pass slot',
      mutate(plan: RenderGraphExecutionPlan) {
        const schedule = new Array(plan.schedule.length);
        schedule[0] = plan.schedule[0];
        schedule[2] = plan.schedule[2];
        schedule[3] = plan.schedule[3];
        return Object.freeze({ ...plan, schedule: Object.freeze(schedule) });
      }
    },
    {
      name: 'a missing pass step',
      mutate(plan: RenderGraphExecutionPlan) {
        return Object.freeze({
          ...plan,
          schedule: Object.freeze([plan.schedule[0]!, plan.schedule.at(-1)!])
        });
      }
    },
    {
      name: 'an order that diverges from retained passes',
      mutate(plan: RenderGraphExecutionPlan) {
        const reversedOrder = Object.freeze([...plan.compiled.order].reverse());
        return Object.freeze({
          ...plan,
          compiled: Object.freeze({ ...plan.compiled, order: reversedOrder }),
          schedule: Object.freeze([
            plan.schedule[0]!,
            {
              ...(plan.schedule[2] as { readonly kind: 'pass'; readonly passId: number }),
              retainedPassIndex: 0
            },
            {
              ...(plan.schedule[1] as { readonly kind: 'pass'; readonly passId: number }),
              retainedPassIndex: 1
            },
            plan.schedule[3]!
          ])
        });
      }
    }
  ])('rejects $name before a callback or submission', ({ mutate }) => {
    const calls: string[] = [];
    const device = new NullDevice({ submissionMode: 'manual' });
    const malformed = mutate(planWithTwoPasses(calls));

    expect(() => new RenderGraphExecutor().execute(malformed, { device })).toThrow(
      /canonical render graph execution plan/i
    );
    expect(calls).toEqual([]);
    expect(device.queue.metrics().submitted).toBe(0);
  });

  test('derives portable transitions as part of canonical execution plan and shares them with Debug IR', () => {
    const plan = planWithTwoPasses([]);
    expect(plan.transitions).toBeDefined();
    expect(Array.isArray(plan.transitions)).toBe(true);

    const device = new NullDevice();
    const executor = new RenderGraphExecutor();
    const result = executor.execute(plan, { device }, { captureDebug: true });
    expect(result.debug.transitions).toEqual(plan.transitions);
  });

  test('rejects execution plan when transitions property is forged or invalid', () => {
    const valid = planWithTwoPasses([]);
    const device = new NullDevice();
    const invalidTransitions = Object.freeze({
      ...valid,
      transitions: 'invalid' as unknown as []
    });

    expect(() => new RenderGraphExecutor().execute(invalidTransitions, { device })).toThrow(
      /canonical render graph execution plan/i
    );
  });
});
