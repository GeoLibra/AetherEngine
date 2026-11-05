import { describe, expect, test } from 'vitest';
import { CookDependencyGraph } from '../../src/assets/cook';

const NODE_COUNT = 10_000;
const nodes = Array.from({ length: NODE_COUNT }, (_, index) => `asset://depth/${index}`);

function createChain(): CookDependencyGraph {
  const graph = new CookDependencyGraph();
  // Forward references keep construction independent of traversal depth.
  for (let index = 0; index < NODE_COUNT - 1; index++) {
    graph.replaceDependencies(nodes[index]!, [nodes[index + 1]!]);
  }
  return graph;
}

describe('CookDependencyGraph deep dependency validation', () => {
  test('retains insertion order when distinct node IDs compare equally', () => {
    const graph = new CookDependencyGraph();
    const first = 'asset://é';
    const second = 'asset://e\u0301';
    expect(first.localeCompare(second)).toBe(0);
    graph.replaceDependencies(first, ['asset://target']);
    graph.replaceDependencies(second, ['asset://target']);
    expect(() => graph.replaceDependencies('asset://target', [first, second])).toThrow(
      `Cook dependency cycle: ${first} -> asset://target -> ${first}`
    );
  });

  test('keeps sorted depth-first cycle selection when candidates are supplied in reverse order', () => {
    const graph = new CookDependencyGraph();
    graph.replaceDependencies('asset://z', ['asset://target']);
    graph.replaceDependencies('asset://a', ['asset://target']);
    expect(() => graph.replaceDependencies('asset://target', ['asset://z', 'asset://a'])).toThrow(
      'Cook dependency cycle: asset://a -> asset://target -> asset://a'
    );
  });

  test('accepts a 10,000-node dependency closure without using the call stack', () => {
    const graph = createChain();
    expect(() => graph.replaceDependencies('asset://root', [nodes[0]!])).not.toThrow();
    expect(graph.dependenciesOf('asset://root')).toEqual([nodes[0]]);
    expect(graph.invalidate(nodes.at(-1)!)).toEqual([...nodes].reverse().concat('asset://root'));
  });

  test('rejects a 10,000-node cycle with the same ordered diagnostic and last-good edges', () => {
    const graph = createChain();
    const terminal = nodes.at(-1)!;
    const expectedCycle = [...nodes, nodes[0]!];
    expect(() => graph.replaceDependencies(terminal, [nodes[0]!])).toThrow(
      `Cook dependency cycle: ${expectedCycle.join(' -> ')}`
    );
    expect(graph.dependenciesOf(terminal)).toEqual([]);
    expect(graph.invalidate(terminal)).toEqual([...nodes].reverse());
  });
});
