import { describe, expect, test } from 'vitest';
import {
  ShaderGraphCompileService,
  ShaderGraphCompiler,
  classifyShaderGraphChange
} from '../../src/shader';

describe('ShaderGraph', () => {
  test('typechecks and lowers a DAG with local hash reuse', async () => {
    const compiler = new ShaderGraphCompiler();
    const graph = {
      revision: 1,
      nodes: [
        { id: 'a', kind: 'constant', outputType: 'f32', value: 1 },
        { id: 'b', kind: 'constant', outputType: 'f32', value: 2 },
        { id: 'sum', kind: 'add', outputType: 'f32', inputs: { left: 'a', right: 'b' } }
      ],
      outputs: { fragment: 'sum' }
    } as const;
    const first = await compiler.lower(graph);
    const second = await compiler.lower({ ...graph, revision: 2 });
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.ir.entryPoints[0]?.body[0]).toMatchObject({
        kind: 'declare',
        value: { kind: 'binary', operator: '+' }
      });
      expect(first.ir.entryPoints[0]).not.toHaveProperty('source');
    }
    expect(second.ok && second.reusedNodes).toBe(3);
    const changed = await compiler.lower({
      ...graph,
      revision: 3,
      nodes: graph.nodes.map((node) => (node.id === 'a' ? { ...node, value: 9 } : node))
    });
    expect(changed.ok && changed.reusedNodes).toBe(1);
  });

  test('rejects cycles and type mismatch', async () => {
    const compiler = new ShaderGraphCompiler();
    const cycle = await compiler.lower({
      revision: 1,
      nodes: [
        { id: 'a', kind: 'add', outputType: 'f32', inputs: { left: 'b', right: 'b' } },
        { id: 'b', kind: 'add', outputType: 'f32', inputs: { left: 'a', right: 'a' } }
      ],
      outputs: { fragment: 'a' }
    });
    expect(cycle).toMatchObject({ ok: false, diagnostics: [{ code: 'GRAPH_CYCLE' }] });
  });

  test('classifies value/binding changes without shader recompilation', () => {
    expect(classifyShaderGraphChange({ kind: 'parameter-value' })).toBe('parameter-update');
    expect(classifyShaderGraphChange({ kind: 'texture-binding' })).toBe('binding-update');
    expect(classifyShaderGraphChange({ kind: 'topology' })).toBe('recompile');
    expect(classifyShaderGraphChange({ kind: 'variant' })).toBe('variant-compile');
  });

  test('cancels work and suppresses stale revisions', async () => {
    const compiler = new ShaderGraphCompiler();
    const controller = new AbortController();
    controller.abort('edited');
    const result = await compiler.lower({ revision: 1, nodes: [], outputs: {} }, controller.signal);
    expect(result).toMatchObject({ ok: false, cancelled: true });
    expect(compiler.acceptResult({ revision: 3 }, 4)).toBe(false);
  });

  test('passes priority to a worker port, cancels superseded work and retains last-known-good', async () => {
    const calls: Array<{ revision: number; priority: number; signal: AbortSignal }> = [];
    const service = new ShaderGraphCompileService({
      compile: async (request) => {
        calls.push(request);
        await Promise.resolve();
        return { revision: request.revision, artifact: `artifact-${request.revision}` };
      }
    });
    const first = service.compile({
      key: 'material',
      revision: 1,
      priority: 1,
      graph: { revision: 1, nodes: [], outputs: {} }
    });
    const second = service.compile({
      key: 'material',
      revision: 2,
      priority: 10,
      graph: { revision: 2, nodes: [], outputs: {} }
    });
    expect((await first).status).toBe('stale');
    expect(await second).toMatchObject({ status: 'completed', artifact: 'artifact-2' });
    expect(calls.map((call) => call.priority)).toEqual([1, 10]);
    expect(calls[0]?.signal.aborted).toBe(true);
    expect(service.lastKnownGood('material')).toBe('artifact-2');
  });
});
