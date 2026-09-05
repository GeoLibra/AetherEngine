import { describe, expect, test } from 'vitest';
import {
  ShaderGraphCompileService,
  ShaderGraphCompiler,
  classifyShaderGraphChange
} from '../../src/shader/experimental/graph';

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
      expect(first.wgsl).toContain('let sum: f32 = a + b;');
      expect(first.wgsl).toContain('@fragment');
      expect(first.wgsl).toContain(
        'fn fragmentMain(stageInput: VertexOutput) -> @location(0) vec4f'
      );
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

  test('distinct IDs with identical expressions generate correct statements without shadowing', async () => {
    const compiler = new ShaderGraphCompiler();
    const graph = {
      revision: 1,
      nodes: [
        { id: 'const_a', kind: 'constant', outputType: 'f32', value: 1 },
        { id: 'const_b', kind: 'constant', outputType: 'f32', value: 1 },
        { id: 'sum', kind: 'add', outputType: 'f32', inputs: { left: 'const_a', right: 'const_b' } }
      ],
      outputs: { fragment: 'sum' }
    } as const;

    const result = await compiler.lower(graph);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reusedNodes).toBe(1); // const_b hits const_a's expression cache
      expect(result.wgsl).toContain('let const_a: f32 = 1.0;');
      expect(result.wgsl).toContain('let const_b: f32 = 1.0;');
      expect(result.wgsl).toContain('let sum: f32 = const_a + const_b;');
    }
  });

  test('artifact sourceHash excludes revision and remains invariant to revision changes', async () => {
    const compiler = new ShaderGraphCompiler();
    const baseGraph = {
      revision: 1,
      nodes: [{ id: 'val', kind: 'constant', outputType: 'f32', value: 3.5 }],
      outputs: { fragment: 'val' }
    } as const;

    const first = await compiler.lower(baseGraph);
    const second = await compiler.lower({ ...baseGraph, revision: 999 });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.sourceHash).toBe(second.sourceHash);
    }
  });

  test('rejects duplicate node IDs', async () => {
    const compiler = new ShaderGraphCompiler();
    const duplicate = await compiler.lower({
      revision: 1,
      nodes: [
        { id: 'dup', kind: 'constant', outputType: 'f32', value: 1 },
        { id: 'dup', kind: 'constant', outputType: 'f32', value: 2 }
      ],
      outputs: { fragment: 'dup' }
    });
    expect(duplicate).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'GRAPH_DUPLICATE_NODE_ID' }]
    });
  });

  test('rejects invalid WGSL identifiers and reserved keywords', async () => {
    const compiler = new ShaderGraphCompiler();

    const invalidChar = await compiler.lower({
      revision: 1,
      nodes: [{ id: 'foo-bar', kind: 'constant', outputType: 'f32', value: 1 }],
      outputs: { fragment: 'foo-bar' }
    });
    expect(invalidChar).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'GRAPH_INVALID_IDENTIFIER' }]
    });

    const reservedKeyword = await compiler.lower({
      revision: 1,
      nodes: [{ id: 'let', kind: 'constant', outputType: 'f32', value: 1 }],
      outputs: { fragment: 'let' }
    });
    expect(reservedKeyword).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'GRAPH_INVALID_IDENTIFIER' }]
    });
  });

  test('rejects unknown node types', async () => {
    const compiler = new ShaderGraphCompiler();
    const unknown = await compiler.lower({
      revision: 1,
      nodes: [{ id: 'unknown_node', kind: 'unsupported_magic', outputType: 'f32' }],
      outputs: { fragment: 'unknown_node' }
    });
    expect(unknown).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'GRAPH_UNKNOWN_NODE_TYPE' }]
    });
  });

  test('rejects missing or extra input ports', async () => {
    const compiler = new ShaderGraphCompiler();

    const missingPort = await compiler.lower({
      revision: 1,
      nodes: [
        { id: 'a', kind: 'constant', outputType: 'f32', value: 1 },
        { id: 'b', kind: 'add', outputType: 'f32', inputs: { left: 'a' } as any }
      ],
      outputs: { fragment: 'b' }
    });
    expect(missingPort).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'GRAPH_MISSING_PORT' }]
    });

    const extraPortOnConstant = await compiler.lower({
      revision: 1,
      nodes: [
        { id: 'a', kind: 'constant', outputType: 'f32', value: 1, inputs: { extra: 'none' } }
      ],
      outputs: { fragment: 'a' }
    });
    expect(extraPortOnConstant).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'GRAPH_INVALID_PORT' }]
    });
  });

  test('rejects invalid literals and blocks string injection', async () => {
    const compiler = new ShaderGraphCompiler();

    const injection = await compiler.lower({
      revision: 1,
      nodes: [{ id: 'evil', kind: 'constant', outputType: 'f32', value: '; evilFunctionCall();' }],
      outputs: { fragment: 'evil' }
    });
    expect(injection).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'GRAPH_INVALID_LITERAL' }]
    });

    const nanVal = await compiler.lower({
      revision: 1,
      nodes: [{ id: 'nan_node', kind: 'constant', outputType: 'f32', value: NaN }],
      outputs: { fragment: 'nan_node' }
    });
    expect(nanVal).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'GRAPH_INVALID_LITERAL' }]
    });
  });

  test('bounded node cache evicts oldest entries at capacity', async () => {
    const compiler = new ShaderGraphCompiler({ cacheCapacity: 2 });
    const makeGraph = (val: number, id: string) =>
      ({
        revision: 1,
        nodes: [{ id, kind: 'constant', outputType: 'f32', value: val }],
        outputs: { fragment: id }
      }) as const;

    await compiler.lower(makeGraph(1, 'a')); // cache has [1]
    await compiler.lower(makeGraph(2, 'b')); // cache has [1, 2]
    await compiler.lower(makeGraph(3, 'c')); // cache evicts [1], now has [2, 3]

    // Lowering 1 again should now miss cache
    const rerun = await compiler.lower(makeGraph(1, 'a_new'));
    expect(rerun.ok && rerun.reusedNodes).toBe(0);

    // Lowering 3 again should hit cache
    const hit3 = await compiler.lower(makeGraph(3, 'c_new'));
    expect(hit3.ok && hit3.reusedNodes).toBe(1);
  });

  test('enforces stage isolation and rejects vertex-only nodes in fragment outputs', async () => {
    const compiler = new ShaderGraphCompiler();
    const stageMismatch = await compiler.lower({
      revision: 1,
      nodes: [{ id: 'attr', kind: 'vertexAttribute', outputType: 'vec3f' }],
      outputs: { fragment: 'attr' }
    });
    expect(stageMismatch).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'GRAPH_STAGE_MISMATCH' }]
    });
  });

  test('supports explicit conversion node (vec4f_from_vec3f) without silent coercion', async () => {
    const compiler = new ShaderGraphCompiler();
    const converted = await compiler.lower({
      revision: 1,
      nodes: [
        { id: 'rgb', kind: 'constant', outputType: 'vec3f', value: [1, 0.5, 0.2] },
        { id: 'alpha', kind: 'constant', outputType: 'f32', value: 1 },
        {
          id: 'color',
          kind: 'vec4f_from_vec3f',
          inputs: { rgb: { nodeId: 'rgb', portId: 'out' }, alpha: 'alpha' }
        }
      ],
      outputs: { fragment: 'color' }
    });
    expect(converted.ok).toBe(true);
    if (converted.ok) {
      expect(converted.wgsl).toContain('let color: vec4f = vec4f(rgb, alpha);');
    }
  });

  test('lowers textureSample with heterogeneous input ports', async () => {
    const compiler = new ShaderGraphCompiler();
    const sampled = await compiler.lower({
      revision: 1,
      nodes: [
        { id: 'tex', kind: 'parameter', outputType: 'texture_2d<f32>' },
        { id: 'smp', kind: 'parameter', outputType: 'sampler' },
        { id: 'uv', kind: 'constant', outputType: 'vec2f', value: [0.5, 0.5] },
        {
          id: 'color',
          kind: 'textureSample',
          inputs: { texture: 'tex', sampler: 'smp', uv: 'uv' }
        }
      ],
      outputs: { fragment: 'color' }
    });
    expect(sampled.ok).toBe(true);
    if (sampled.ok) {
      expect(sampled.wgsl).toContain('let color: vec4f = textureSample(tex, smp, uv);');
    }
  });
});
