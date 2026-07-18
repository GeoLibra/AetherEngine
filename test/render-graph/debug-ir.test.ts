import { describe, expect, test } from 'vitest';
import { RenderGraphBuilder } from '../../src/render-graph/builder';
import { compileRenderGraph } from '../../src/render-graph/compiler';
import { createRenderGraphDebugIR, toRenderGraphDebugJSON } from '../../src/render-graph/debug-ir';
import type { BufferDescriptor } from '../../src/render-graph/types';

const BUFFER: BufferDescriptor = Object.freeze({
  size: 256,
  usage: Object.freeze(['copy-src', 'copy-dst'] as const)
});

function createFixture(aliasing: boolean) {
  const graph = new RenderGraphBuilder();
  const first = graph.createBuffer(BUFFER);
  const second = graph.createBuffer(BUFFER);
  graph.addPass({
    id: 'first',
    setup(pass) {
      pass.sideEffect('observable first');
      return pass.writeBuffer(first, 'copy-dst');
    },
    run() {}
  });
  graph.addPass({
    id: 'second',
    setup(pass) {
      const output = pass.writeBuffer(second, 'copy-dst');
      pass.exportBuffer(output, 'copy-src');
      return output;
    },
    run() {}
  });
  const snapshot = graph.build();
  return createRenderGraphDebugIR(snapshot, compileRenderGraph(snapshot), { aliasing });
}

describe('render graph Debug IR', () => {
  test('is deeply immutable, deterministic, serializable, and explainable', () => {
    const first = createFixture(true);
    const second = createFixture(true);
    const firstJSON = toRenderGraphDebugJSON(first);
    const parsed = JSON.parse(firstJSON) as Record<string, unknown>;

    expect(firstJSON).toBe(toRenderGraphDebugJSON(second));
    expect(parsed).toMatchObject({ schemaVersion: 1, logicalChecksum: first.logicalChecksum });
    expect(first.passes[0]).toMatchObject({ id: 'first', retained: true });
    expect(first.resources[0]?.versions).toHaveLength(2);
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
});
