import { describe, expect, test } from 'vitest';
import { RenderGraphBuilder } from '../../src/render-graph/builder';
import {
  analyzeResourceLifetimes,
  compileRenderGraph,
  derivePortableTransitions,
  planResourceAliases
} from '../../src/render-graph/compiler';
import type { BufferDescriptor, TextureDescriptor } from '../../src/render-graph/types';

const BUFFER: BufferDescriptor = Object.freeze({
  size: 256,
  usage: Object.freeze(['copy-src', 'copy-dst', 'storage-read', 'storage-write'] as const)
});

const TEXTURE: TextureDescriptor = Object.freeze({
  width: 64,
  height: 64,
  depthOrArrayLayers: 1,
  mipLevelCount: 1,
  sampleCount: 1,
  format: 'rgba8unorm',
  usage: Object.freeze(['copy-src', 'copy-dst', 'sampled'] as const)
});

describe('render graph lifetime analysis', () => {
  test('computes first and last use only from retained passes', () => {
    const graph = new RenderGraphBuilder();
    const kept = graph.createBuffer(BUFFER);
    const dead = graph.createBuffer(BUFFER);
    let keptVersion = kept;

    graph.addCopyPass({
      id: 'produce-kept',
      setup(pass) {
        keptVersion = pass.writeBuffer(kept, 'copy-dst');
        return keptVersion;
      },
      run() {}
    });
    graph.addCopyPass({
      id: 'consume-kept',
      setup(pass) {
        pass.readBuffer(keptVersion, 'copy-src');
        pass.exportResource(keptVersion, 'copy-src');
        return undefined;
      },
      run() {}
    });
    graph.addCopyPass({
      id: 'dead-producer',
      setup(pass) {
        return pass.writeBuffer(dead, 'copy-dst');
      },
      run() {}
    });

    const snapshot = graph.build();
    const compiled = compileRenderGraph(snapshot);

    expect(compiled.order).toEqual([0, 1]);
    expect(analyzeResourceLifetimes(snapshot, compiled)).toEqual([
      expect.objectContaining({
        resourceId: kept.resourceId,
        firstUse: 0,
        lastUse: 1,
        firstPassId: 0,
        lastPassId: 1
      })
    ]);
  });
});

describe('render graph deterministic alias planning', () => {
  test('greedily aliases compatible disjoint transient lifetimes', () => {
    const graph = new RenderGraphBuilder();
    const first = graph.createBuffer(BUFFER);
    const second = graph.createBuffer(BUFFER);
    graph.addCopyPass({
      id: 'first',
      setup(pass) {
        pass.sideEffect('keep first');
        return pass.writeBuffer(first, 'copy-dst');
      },
      run() {}
    });
    graph.addCopyPass({
      id: 'second',
      setup(pass) {
        pass.sideEffect('keep second');
        return pass.writeBuffer(second, 'copy-dst');
      },
      run() {}
    });
    const snapshot = graph.build();
    const lifetimes = analyzeResourceLifetimes(snapshot, compileRenderGraph(snapshot));
    const plan = planResourceAliases(snapshot, lifetimes);

    expect(plan.allocationCount).toBe(1);
    expect(plan.aliasGroupCount).toBe(1);
    expect(plan.decisions.map((decision) => decision.allocationId)).toEqual([0, 0]);
    expect(plan.decisions[1]?.aliasedWithResourceIds).toEqual([first.resourceId]);
  });

  test('records every reason inspected before selecting a compatible allocation', () => {
    const graph = new RenderGraphBuilder();
    const overlapping = graph.createBuffer(BUFFER);
    const incompatible = graph.createBuffer({ ...BUFFER, size: 512 });
    const imported = graph.createBuffer(BUFFER, {
      origin: {
        kind: 'imported',
        initialState: 'copy-src',
        acquire: { kind: 'external-acquire', id: 'external-buffer' }
      }
    });
    const candidate = graph.createBuffer(BUFFER);
    let overlappingVersion = overlapping;

    graph.addCopyPass({
      id: 'overlap-start',
      setup(pass) {
        pass.sideEffect('retain overlap start');
        overlappingVersion = pass.writeBuffer(overlapping, 'copy-dst');
        return overlappingVersion;
      },
      run() {}
    });
    graph.addCopyPass({
      id: 'incompatible',
      setup(pass) {
        pass.sideEffect('retain incompatible');
        return pass.writeBuffer(incompatible, 'copy-dst');
      },
      run() {}
    });
    graph.addCopyPass({
      id: 'imported',
      setup(pass) {
        pass.sideEffect('retain imported');
        return pass.readBuffer(imported, 'copy-src');
      },
      run() {}
    });
    graph.addCopyPass({
      id: 'candidate',
      setup(pass) {
        pass.sideEffect('retain candidate');
        return pass.writeBuffer(candidate, 'copy-dst');
      },
      run() {}
    });
    graph.addCopyPass({
      id: 'overlap-end',
      setup(pass) {
        pass.readBuffer(overlappingVersion, 'copy-src');
        pass.sideEffect('retain overlap end');
        return undefined;
      },
      run() {}
    });
    const snapshot = graph.build();
    const lifetimes = analyzeResourceLifetimes(snapshot, compileRenderGraph(snapshot));
    const plan = planResourceAliases(snapshot, lifetimes, {
      backendAlignments: {
        [overlapping.resourceId]: 256,
        [incompatible.resourceId]: 512,
        [imported.resourceId]: 256,
        [candidate.resourceId]: 256
      },
      pendingResourceIds: new Set([imported.resourceId])
    });
    const candidateDecision = plan.decisions.find(
      (decision) => decision.resourceId === candidate.resourceId
    );
    const allReasons = plan.decisions.flatMap((decision) =>
      decision.rejections.map((rejection) => rejection.reason)
    );

    expect(candidateDecision?.rejections.map((rejection) => rejection.reason)).toEqual([
      'overlapping-lifetime',
      'descriptor-incompatible',
      'backend-alignment'
    ]);
    expect(allReasons).toContain('origin-not-transient');
    expect(allReasons).toContain('submission-pending');
  });

  test('excludes history resources from ordinary transient aliasing', () => {
    const graph = new RenderGraphBuilder();
    const history = graph.createBuffer(BUFFER, {
      origin: { kind: 'history', key: 'taa', slots: 2 },
      historyValid: true
    });
    graph.addCopyPass({
      id: 'history',
      setup(pass) {
        pass.readBuffer(history, 'copy-src');
        pass.sideEffect('retain history');
        return undefined;
      },
      run() {}
    });
    const snapshot = graph.build();
    const plan = planResourceAliases(
      snapshot,
      analyzeResourceLifetimes(snapshot, compileRenderGraph(snapshot))
    );

    expect(plan.decisions[0]?.rejections).toEqual([
      expect.objectContaining({ reason: 'origin-not-transient' })
    ]);
  });
});

describe('portable logical transitions', () => {
  test('records only logical usages, overlapping ranges, pass boundaries, and submission index', () => {
    const graph = new RenderGraphBuilder();
    const imported = graph.createTexture(TEXTURE, {
      origin: {
        kind: 'imported',
        initialState: 'copy-src',
        acquire: { kind: 'external-acquire', id: 'input' }
      }
    });
    let written = imported;
    graph.addCopyPass({
      id: 'read',
      setup(pass) {
        return pass.readTexture(imported, 'copy-src');
      },
      run() {}
    });
    graph.addCopyPass({
      id: 'write',
      setup(pass) {
        written = pass.writeTexture(imported, 'copy-dst');
        return written;
      },
      run() {}
    });
    graph.addCopyPass({
      id: 'sample',
      setup(pass) {
        pass.readTexture(written, 'sampled');
        pass.exportResource(written, 'copy-src');
        return undefined;
      },
      run() {}
    });
    const snapshot = graph.build();
    const transitions = derivePortableTransitions(snapshot, compileRenderGraph(snapshot), {
      submissionIndex: 4
    });

    expect(
      transitions.map(({ beforeUsage, afterUsage, fromPassId, toPassId }) => ({
        beforeUsage,
        afterUsage,
        fromPassId,
        toPassId
      }))
    ).toEqual([
      { beforeUsage: 'copy-src', afterUsage: 'copy-dst', fromPassId: 0, toPassId: 1 },
      { beforeUsage: 'copy-dst', afterUsage: 'sampled', fromPassId: 1, toPassId: 2 },
      { beforeUsage: 'sampled', afterUsage: 'copy-src', fromPassId: 2, toPassId: 2 }
    ]);
    for (const transition of transitions) {
      expect(transition.submissionIndex).toBe(4);
      expect(Object.keys(transition).sort()).toEqual([
        'afterUsage',
        'beforeUsage',
        'fromPassId',
        'range',
        'resourceId',
        'resourceKind',
        'submissionIndex',
        'toPassId'
      ]);
    }
  });

  test('preserves the latest logical usage independently for disjoint subranges', () => {
    const graph = new RenderGraphBuilder();
    const imported = graph.createBuffer(
      { size: 128, usage: ['copy-src', 'copy-dst', 'storage-write'] },
      {
        origin: {
          kind: 'imported',
          initialState: 'copy-src',
          acquire: { kind: 'external-acquire', id: 'partial-input' }
        }
      }
    );
    let first = imported;
    let second = imported;
    graph.addCopyPass({
      id: 'first-half',
      setup(pass) {
        first = pass.writeBuffer(imported, 'copy-dst', { offset: 0, size: 64 });
        return first;
      },
      run() {}
    });
    graph.addCopyPass({
      id: 'second-half',
      setup(pass) {
        second = pass.writeBuffer(first, 'storage-write', { offset: 64, size: 64 });
        return second;
      },
      run() {}
    });
    graph.addCopyPass({
      id: 'whole-read',
      setup(pass) {
        pass.readBuffer(second, 'copy-src');
        pass.exportResource(second, 'copy-src');
        return undefined;
      },
      run() {}
    });
    const snapshot = graph.build();
    const transitions = derivePortableTransitions(snapshot, compileRenderGraph(snapshot));
    const readTransitions = transitions.filter(
      (transition) => transition.toPassId === 2 && transition.afterUsage === 'copy-src'
    );

    expect(
      readTransitions.map((transition) => ({
        before: transition.beforeUsage,
        range:
          transition.range.kind === 'buffer' ? [transition.range.offset, transition.range.end] : []
      }))
    ).toEqual([
      { before: 'storage-write', range: [64, 128] },
      { before: 'copy-dst', range: [0, 64] }
    ]);
  });
});
