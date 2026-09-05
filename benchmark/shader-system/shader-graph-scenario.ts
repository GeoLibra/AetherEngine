import type { ShaderGraph, ShaderGraphNode } from '../../src/shader/experimental/graph/types';
import { ShaderGraphCompiler } from '../../src/shader/experimental/graph/graph-compiler';
import { lowerVerticalSliceGraph } from '../../src/shader/experimental/graph/vertical-slice';

export interface ShaderGraphScenarioInput {
  readonly chainLength: number;
  readonly cacheHits: number;
}

export interface ShaderGraphScenarioResult {
  readonly nodeCount: number;
  readonly reusedNodes: number;
  readonly sliceLowerOk: boolean;
  readonly checksum: number;
}

/**
 * Builds a deterministic procedural arithmetic shader graph.
 */
function buildArithmeticGraph(chainLength: number): ShaderGraph {
  const nodes: ShaderGraphNode[] = [
    { id: 'c0', kind: 'constant', outputType: 'f32', value: 1.0 },
    { id: 'c1', kind: 'constant', outputType: 'f32', value: 2.0 }
  ];

  let prevId = 'c0';
  for (let i = 2; i < chainLength; i++) {
    const id = `node_${i}`;
    nodes.push({
      id,
      kind: 'add',
      outputType: 'f32',
      inputs: {
        left: prevId,
        right: 'c1'
      }
    });
    prevId = id;
  }

  return {
    revision: 1,
    nodes,
    outputs: {
      fragment: prevId
    }
  };
}

/**
 * Deterministic correctness oracle and performance scenario for ShaderGraph compilation and Merkle caching.
 */
export async function runShaderGraphScenario(
  input: ShaderGraphScenarioInput
): Promise<ShaderGraphScenarioResult> {
  if (input.chainLength < 3 || input.cacheHits < 0) {
    throw new Error('Invalid ShaderGraph scenario input parameters.');
  }

  const graph = buildArithmeticGraph(input.chainLength);
  const compiler = new ShaderGraphCompiler({ cacheCapacity: 2048 });

  // Cold compilation (populates Merkle cache)
  const coldResult = await compiler.lower(graph);
  if (!coldResult.ok) {
    throw new Error('Cold ShaderGraph compilation failed.');
  }

  let totalReused = 0;
  // Repeated compilation (hits Merkle cache)
  for (let i = 0; i < input.cacheHits; i++) {
    const warmResult = await compiler.lower(graph);
    if (!warmResult.ok) {
      throw new Error('Warm ShaderGraph compilation failed.');
    }
    totalReused += warmResult.reusedNodes;
  }

  // Also verify vertical slice lowering
  const sliceGraph: ShaderGraph = {
    revision: 1,
    nodes: [
      { id: 'pos', kind: 'vertexAttribute', outputType: 'vec3f', location: 0 },
      { id: 'tint', kind: 'parameter', outputType: 'vec4f', group: 0, binding: 0 },
      { id: 'tex', kind: 'parameter', outputType: 'texture_2d<f32>', group: 1, binding: 0 },
      { id: 'smp', kind: 'parameter', outputType: 'sampler', group: 1, binding: 1 },
      { id: 'uv', kind: 'constant', outputType: 'vec2f', value: [0.5, 0.5] },
      { id: 'sample', kind: 'textureSample', inputs: { texture: 'tex', sampler: 'smp', uv: 'uv' } },
      { id: 'color', kind: 'multiply', inputs: { left: 'sample', right: 'tint' } },
      { id: 'outColor', kind: 'fragmentOutput', inputs: { color: 'color' } }
    ],
    outputs: {
      vertex: 'pos',
      fragment: 'outColor'
    }
  };
  const sliceResult = lowerVerticalSliceGraph(sliceGraph);
  if (!sliceResult.ok) {
    throw new Error('Vertical slice ShaderGraph lowering failed.');
  }

  // Deterministic structural correctness assertions
  if (
    !coldResult.wgsl.includes(
      `vec4f(${graph.outputs.fragment}, ${graph.outputs.fragment}, ${graph.outputs.fragment}, 1.0)`
    )
  ) {
    throw new Error('Arithmetic graph WGSL does not adapt scalar f32 to vec4f in fragment return.');
  }
  if (!sliceResult.wgsl.includes('@location(0) pos: vec3f')) {
    throw new Error('Vertical slice WGSL missing @location(0) pos: vec3f attribute.');
  }
  if (!sliceResult.wgsl.includes('output.position = vec4f(pos, 1.0)')) {
    throw new Error('Vertical slice WGSL does not drive clip-space position from pos output.');
  }
  if (!sliceResult.wgsl.includes('textureSample(tex, smp, uv)')) {
    throw new Error('Vertical slice WGSL missing textureSample expression.');
  }

  // Deterministic checksum over both generated WGSL outputs and reused counts
  let hashVal = totalReused * 31 + input.chainLength;
  for (let i = 0; i < coldResult.wgsl.length; i++) {
    hashVal = (Math.imul(hashVal, 33) ^ coldResult.wgsl.charCodeAt(i)) >>> 0;
  }
  for (let i = 0; i < sliceResult.wgsl.length; i++) {
    hashVal = (Math.imul(hashVal, 37) ^ sliceResult.wgsl.charCodeAt(i)) >>> 0;
  }

  return Object.freeze({
    nodeCount: graph.nodes.length,
    reusedNodes: totalReused,
    sliceLowerOk: sliceResult.ok,
    checksum: hashVal
  });
}
