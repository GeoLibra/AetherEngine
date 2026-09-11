import { describe, expect, test } from 'vitest';
import { RenderGraphBuilder } from '../../src/render-graph/builder';
import {
  compileRenderGraph,
  createRenderGraphDebugIR,
  toRenderGraphDebugJSON,
  type RenderGraphHistoryDebugBinding
} from '../../src/render-graph/compiler';
import { partitionRasterGroups } from '../../src/render-graph/compiler/fusion';
import type { BufferDescriptor } from '../../src/render-graph/types';

const BUFFER: BufferDescriptor = Object.freeze({
  size: 256,
  usage: Object.freeze(['copy-src', 'copy-dst'] as const)
});

function createFixture(aliasing: boolean) {
  const graph = new RenderGraphBuilder();
  const first = graph.createBuffer(BUFFER);
  const second = graph.createBuffer(BUFFER);
  graph.addCopyPass({
    id: 'first',
    setup(pass) {
      pass.sideEffect('observable first');
      return pass.writeBuffer(first, 'copy-dst');
    },
    run() {}
  });
  graph.addCopyPass({
    id: 'second',
    setup(pass) {
      const output = pass.writeBuffer(second, 'copy-dst');
      pass.exportResource(output, 'copy-src');
      return output;
    },
    run() {}
  });
  const snapshot = graph.build();
  return createRenderGraphDebugIR(snapshot, compileRenderGraph(snapshot), { aliasing });
}

describe('render graph Debug IR', () => {
  test('captures fusion membership, split decisions, and counters from the physical plan', () => {
    const graph = new RenderGraphBuilder();
    const color = graph.createTexture({
      width: 4,
      height: 4,
      depthOrArrayLayers: 1,
      mipLevelCount: 1,
      sampleCount: 1,
      format: 'rgba8unorm',
      usage: ['color-attachment']
    });
    const firstBuffer = graph.createBuffer(
      { ...BUFFER, usage: ['uniform'] },
      {
        origin: {
          kind: 'imported',
          initialState: 'uniform',
          acquire: { kind: 'external-acquire', id: 'buf-1' }
        }
      }
    );
    const secondBuffer = graph.createBuffer(
      { ...BUFFER, usage: ['uniform'] },
      {
        origin: {
          kind: 'imported',
          initialState: 'uniform',
          acquire: { kind: 'external-acquire', id: 'buf-2' }
        }
      }
    );
    let current = color;
    graph.addRasterPass({
      id: 'clear',
      setup(pass) {
        current = pass.colorAttachment(0, current, { load: 'clear', store: 'auto' });
        pass.readBuffer(firstBuffer, 'uniform');
        pass.sideEffect('clear');
        return {};
      },
      run() {}
    });
    graph.addRasterPass({
      id: 'draw',
      setup(pass) {
        current = pass.colorAttachment(0, current, { load: 'load', store: 'store' });
        pass.readBuffer(secondBuffer, 'uniform');
        pass.sideEffect('draw');
        return {};
      },
      run() {}
    });

    const snapshot = graph.build();
    const compiled = compileRenderGraph(snapshot);
    const fusion = partitionRasterGroups(snapshot, compiled);
    const debug = createRenderGraphDebugIR(snapshot, compiled, { fusion });
    expect(debug.fusion).toBeDefined();
    const debugFusion = debug.fusion!;

    expect(debugFusion.groups).toMatchObject([{ passIds: [0, 1] }]);
    expect(debugFusion.splitRecords).toEqual([]);
    expect(debugFusion.counters).toMatchObject({
      retainedLogicalRasterPasses: 2,
      physicalRasterGroups: 1,
      fusedBoundariesCount: 1
    });
    expect(
      debug.lifetimes.find((lifetime) => lifetime.resourceId === firstBuffer.resourceId)
    ).toMatchObject({ firstUse: 0, lastUse: 1 });
    expect(
      debug.lifetimes.find((lifetime) => lifetime.resourceId === secondBuffer.resourceId)
    ).toMatchObject({ firstUse: 0, lastUse: 1 });
  });

  test('is deeply immutable, deterministic, serializable, and explainable', () => {
    const first = createFixture(true);
    const second = createFixture(true);
    const firstJSON = toRenderGraphDebugJSON(first);
    const parsed = JSON.parse(firstJSON) as Record<string, unknown>;

    expect(firstJSON).toBe(toRenderGraphDebugJSON(second));
    expect(parsed).toMatchObject({ schemaVersion: 1, logicalChecksum: first.logicalChecksum });
    expect(first.passes[0]).toMatchObject({ id: 'first', retained: true });
    expect(first.resources[0]?.versions).toHaveLength(2);
    expect(first.resources.map((resource) => resource.disposition)).toEqual([
      'internal',
      'exported'
    ]);
    expect(first.aliasDecisions[1]).toMatchObject({ allocationId: 0 });
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.resources[0]?.versions)).toBe(true);
  });

  test('keeps the logical checksum unchanged when physical aliasing is disabled', () => {
    const aliased = createFixture(true);
    const unaliased = createFixture(false);

    expect(aliased.logicalChecksum).toBe(unaliased.logicalChecksum);
    expect(aliased.aliasDecisions.map((decision) => decision.allocationId)).toEqual([0, 0]);
    expect(unaliased.aliasDecisions.map((decision) => decision.allocationId)).toEqual([0, 1]);
    expect(aliased.checksum).not.toBe(unaliased.checksum);
  });

  test('snapshots caller-provided history debug values before deeply freezing the IR', () => {
    const graph = new RenderGraphBuilder();
    const buffer = graph.createBuffer(BUFFER);
    graph.addCopyPass({
      id: 'history-debug',
      setup(pass) {
        return pass.writeBuffer(buffer, 'copy-dst');
      },
      run() {}
    });
    const snapshot = graph.build();
    const pendingSubmissionIds = [7];
    const schedule = [{ kind: 'submission' as const }];
    const history = {
      readableSlot: undefined,
      writableSlot: 0,
      versionSlots: [{ version: 0, slot: 0 }],
      slots: [
        {
          slot: 0,
          valid: false,
          invalidationReason: 'new' as const,
          producerSubmissionId: undefined,
          pendingSubmissionIds,
          pendingRetirement: false
        }
      ]
    };

    const debug = createRenderGraphDebugIR(snapshot, compileRenderGraph(snapshot), {
      historyStates: new Map([[0, history]]),
      schedule
    });

    expect(Object.isExtensible(history)).toBe(true);
    expect(Object.isExtensible(schedule[0])).toBe(true);
    pendingSubmissionIds.push(8);
    expect(debug.resources[0]?.history?.slots[0]?.pendingSubmissionIds).toEqual([7]);
    expect(Object.isFrozen(debug.resources[0]?.history)).toBe(true);
  });

  test('omits undeclared Debug IR option fields and rejects malformed declared values before freezing', () => {
    const graph = new RenderGraphBuilder();
    const buffer = graph.createBuffer(BUFFER);
    graph.addCopyPass({
      id: 'untrusted-debug-options',
      setup(pass) {
        return pass.writeBuffer(buffer, 'copy-dst');
      },
      run() {}
    });
    const snapshot = graph.build();
    const extra = { callback: () => undefined } as Record<string, unknown>;
    extra.self = extra;
    const schedule = [{ kind: 'submission' as const, extra }] as unknown as readonly {
      readonly kind: 'submission';
    }[];
    const history = {
      readableSlot: undefined,
      writableSlot: 0,
      versionSlots: [{ version: 0, slot: 0 }],
      slots: [
        {
          slot: 0,
          valid: false,
          invalidationReason: 'new' as const,
          producerSubmissionId: undefined,
          pendingSubmissionIds: [],
          pendingRetirement: false,
          extra
        }
      ]
    };

    const debug = createRenderGraphDebugIR(snapshot, compileRenderGraph(snapshot), {
      historyStates: new Map([[0, history]]),
      schedule
    });

    expect(Object.isExtensible(extra)).toBe(true);
    expect(Object.hasOwn(debug.schedule[0] as object, 'extra')).toBe(false);
    expect(Object.hasOwn(debug.resources[0]?.history?.slots[0] as object, 'extra')).toBe(false);
    expect(toRenderGraphDebugJSON(debug)).not.toContain('callback');

    const cycle: unknown[] = [];
    cycle.push(cycle);
    const malformedHistory = {
      ...history,
      slots: [
        {
          ...history.slots[0],
          pendingSubmissionIds: cycle as unknown as readonly number[]
        }
      ]
    };
    expect(() =>
      createRenderGraphDebugIR(snapshot, compileRenderGraph(snapshot), {
        historyStates: new Map([[0, malformedHistory as unknown as RenderGraphHistoryDebugBinding]])
      })
    ).toThrow(/pending submission id/i);
    expect(Object.isExtensible(cycle)).toBe(true);
  });

  test('derives present disposition from the matching imported surface terminal', () => {
    const graph = new RenderGraphBuilder();
    const output = graph.createTexture(
      {
        width: 4,
        height: 4,
        depthOrArrayLayers: 1,
        mipLevelCount: 1,
        sampleCount: 1,
        format: 'rgba8unorm',
        usage: ['color-attachment']
      },
      {
        origin: {
          kind: 'imported',
          initialState: 'undefined',
          acquire: { kind: 'external-acquire', id: 'main' }
        }
      }
    );
    graph.addRasterPass({
      id: 'present',
      setup(pass) {
        const color = pass.colorAttachment(0, output, { load: 'clear', store: 'store' });
        pass.present(color, { kind: 'surface-frame', id: 'main' });
        return color;
      },
      run() {}
    });
    const snapshot = graph.build();

    expect(
      createRenderGraphDebugIR(snapshot, compileRenderGraph(snapshot)).resources[0]
    ).toMatchObject({ disposition: 'present' });
  });
});
