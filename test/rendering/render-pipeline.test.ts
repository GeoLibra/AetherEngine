import { describe, expect, test, vi } from 'vitest';
import {
  OverlayReconciler,
  PreparedAssetRegistry,
  buildRenderPhase,
  computeVisibility,
  resolvePipelineKey,
  runRenderFrame,
  type PhaseItem,
  type PreparedVariantKey,
  type RenderEntityId,
  type RenderView
} from '../../src/rendering';
import { RenderGraphBuilder } from '../../src/render-graph/builder';
import { compileRenderGraph } from '../../src/render-graph/compiler';
import { createRenderGraphExecutionPlan } from '../../src/render-graph/executor';
import type { RHISubmission, SubmissionResult } from '../../src/rhi';
import { Frustum, Mat4 } from '../../src/math';

const entity = (value: number) => value as RenderEntityId;
const key: PreparedVariantKey = {
  assetId: 'mesh',
  payloadVersion: 2,
  deviceGeneration: 3,
  featurePolicyKey: 'desktop',
  abiVersion: '1'
};

function framePlan() {
  const graph = new RenderGraphBuilder();
  const snapshot = graph.build();
  return createRenderGraphExecutionPlan(snapshot, compileRenderGraph(snapshot));
}

describe('prepared asset lifecycle', () => {
  test('waits for both leases and typed submissions before destroying a retired asset', async () => {
    let settle!: (result: SubmissionResult) => void;
    const submission: RHISubmission = {
      id: 1,
      status: 'pending',
      done: new Promise((resolve) => {
        settle = resolve;
      })
    };
    const destroy = vi.fn();
    const registry = new PreparedAssetRegistry();
    registry.publish({ key, value: { gpu: true } }, destroy);
    const lease = registry.acquire<{ gpu: boolean }>(key)!;
    lease.retainUntil(submission);
    registry.retire(key);
    lease.dispose();
    expect(destroy).not.toHaveBeenCalled();
    settle({ status: 'completed' });
    await submission.done;
    await Promise.resolve();
    expect(destroy).toHaveBeenCalledOnce();
    expect(registry.acquire(key)).toBeUndefined();
  });
});

describe('visibility and render phases', () => {
  const view: RenderView = {
    id: 'main',
    camera: entity(99),
    surface: 'surface',
    viewport: { x: 0, y: 0, width: 640, height: 480 },
    layerMask: 1,
    featurePolicyKey: 'desktop',
    historyKey: 'main-history',
    frustum: Frustum.fromViewProjection(Mat4.perspective(Math.PI / 2, 1, 0.1, 10))
  };

  test('isolates visibility by view and layer policy', () => {
    expect(
      computeVisibility(view, [
        {
          entity: entity(2),
          layerMask: 1,
          bounds: { kind: 'sphere', center: [0, 0, -2], radius: 0.25 }
        },
        {
          entity: entity(1),
          layerMask: 2,
          bounds: { kind: 'sphere', center: [0, 0, -2], radius: 0.25 }
        },
        {
          entity: entity(3),
          layerMask: 1,
          bounds: { kind: 'sphere', center: [20, 0, -2], radius: 0.25 }
        }
      ]).entities
    ).toEqual([entity(2)]);
  });

  test('sorts opaque for aggregation and transparent back-to-front without cross-order batching', () => {
    const item = (overrides: Partial<PhaseItem>): PhaseItem => ({
      entity: entity(1),
      phase: 'opaque',
      pipelineKey: 'p',
      materialKey: 'm',
      meshKey: 'mesh',
      bindingKey: 'b',
      drawKey: 'd',
      distance: 0,
      insertionOrder: 0,
      ...overrides
    });
    const opaque = buildRenderPhase('main', 'opaque', [
      item({ entity: entity(2) }),
      item({ entity: entity(1) })
    ]);
    expect(opaque.items.map((entry) => entry.entity)).toEqual([entity(1), entity(2)]);
    expect(opaque.batches).toHaveLength(1);
    const transparent = buildRenderPhase('main', 'transparent', [
      item({ phase: 'transparent', entity: entity(1), distance: 2 }),
      item({ phase: 'transparent', entity: entity(2), distance: 5 })
    ]);
    expect(transparent.items.map((entry) => entry.entity)).toEqual([entity(2), entity(1)]);
    expect(transparent.batches).toHaveLength(2);
  });

  test('detaches published phase items from caller-owned records', () => {
    const phaseItem: PhaseItem = {
      entity: entity(1),
      phase: 'opaque',
      pipelineKey: 'pipeline-before',
      materialKey: 'material',
      meshKey: 'mesh',
      bindingKey: 'binding',
      drawKey: 'draw',
      distance: 0,
      insertionOrder: 0
    };
    const snapshot = buildRenderPhase('main', 'opaque', [phaseItem]);

    (phaseItem as { pipelineKey: string }).pipelineKey = 'pipeline-after';

    expect(snapshot.items[0]?.pipelineKey).toBe('pipeline-before');
    expect(snapshot.batches[0]?.items[0]?.pipelineKey).toBe('pipeline-before');
  });

  test('pipeline identity includes every compatibility axis', () => {
    const base = {
      shader: 's',
      material: 'm',
      vertexLayout: 'v',
      attachments: ['rgba8'],
      sampleCount: 1,
      featurePolicy: 'p'
    };
    expect(resolvePipelineKey(base)).not.toBe(resolvePipelineKey({ ...base, sampleCount: 4 }));
  });
});

describe('overlay and frame orchestration', () => {
  test('rejects a missing compiled graph plan before execution can rebuild it', () => {
    let executed = false;
    const activeView: RenderView = {
      id: 'main',
      camera: entity(1),
      surface: 'main',
      viewport: { x: 0, y: 0, width: 1, height: 1 },
      layerMask: 1,
      featurePolicyKey: 'test',
      historyKey: 'main-history'
    };

    expect(() =>
      runRenderFrame({
        frame: 1,
        views: [activeView],
        extractedEntities: 0,
        extractBytes: 0,
        stages: {
          prepare: () => ({ hits: 0, misses: 0, uploadBytes: 0 }),
          queue: () => ({ items: 0 }),
          sort: () => ({ batches: 0 }),
          build: () => undefined as never,
          execute: () => {
            executed = true;
          }
        }
      })
    ).toThrow(/compiled render graph plan/i);
    expect(executed).toBe(false);
  });

  test('reconciles isolated keyed scopes and reports deterministic truncation', () => {
    const overlays = new OverlayReconciler();
    const policy = {
      owner: 'editor',
      maxPrimitives: 1,
      maxUploadBytes: 10,
      overflow: 'truncate' as const
    };
    const first = overlays.reconcile('selection', policy, [
      { key: 'b', uploadBytes: 5, payload: 2 },
      { key: 'a', uploadBytes: 5, payload: 1 }
    ]);
    expect(first.created.map((item) => item.key)).toEqual(['a']);
    expect(first.diagnostic).toMatchObject({ kind: 'truncated', omitted: 1 });
    expect(overlays.destroyScope('selection')).toEqual(['a']);
  });

  test('prepares every view but skips graph execution for suspended surfaces and records metrics', () => {
    const calls: string[] = [];
    const compiledPlan = framePlan();
    const makeView = (id: string, width: number): RenderView => ({
      id,
      camera: entity(id.length),
      surface: id,
      viewport: { x: 0, y: 0, width, height: 10 },
      layerMask: 1,
      featurePolicyKey: id,
      historyKey: `${id}-history`
    });
    const metrics = runRenderFrame({
      frame: 1,
      views: [makeView('main', 10), makeView('preview', 0)],
      extractedEntities: 3,
      extractBytes: 48,
      stages: {
        prepare: ({ view }) => {
          calls.push(`prepare:${view.id}`);
          return { hits: 1, misses: 0, uploadBytes: 0 };
        },
        queue: ({ view }) => {
          calls.push(`queue:${view.id}`);
          return { items: 2, skipped: ['prepare-pending'] };
        },
        sort: ({ view }) => {
          calls.push(`sort:${view.id}`);
          return { batches: 1 };
        },
        build: ({ view }) => {
          calls.push(`build:${view.id}`);
          return compiledPlan;
        },
        execute: ({ view }, plan) => {
          expect(plan).toBe(compiledPlan);
          calls.push(`execute:${view.id}:compiled`);
        }
      }
    });
    expect(calls).toEqual([
      'prepare:main',
      'queue:main',
      'sort:main',
      'build:main',
      'execute:main:compiled',
      'prepare:preview'
    ]);
    expect(metrics).toMatchObject({ prepareHits: 2, phaseItems: 2, batches: 1 });
    expect(metrics.skipped).toMatchObject({ 'surface-suspended': 1, 'prepare-pending': 1 });
  });
});
