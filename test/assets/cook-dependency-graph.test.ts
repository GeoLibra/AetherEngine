import { describe, expect, test } from 'vitest';
import { CookDependencyGraph } from '../../src/assets/cook';

describe('CookDependencyGraph', () => {
  test('invalidates the changed source and its transitive dependents in dependency order', () => {
    const graph = new CookDependencyGraph();
    graph.replaceDependencies('shader://lighting', ['shader://math']);
    graph.replaceDependencies('material://standard', ['shader://lighting']);

    expect(graph.invalidate('shader://math')).toEqual([
      'shader://math',
      'shader://lighting',
      'material://standard'
    ]);
  });

  test('retains a reverse edge for a missing dependency so adding it invalidates its consumer', () => {
    const graph = new CookDependencyGraph();
    graph.replaceDependencies('shader://lighting', ['shader://future-library']);

    expect(graph.invalidate('shader://future-library')).toEqual([
      'shader://future-library',
      'shader://lighting'
    ]);
  });

  test('rejects a dependency cycle without replacing the last-good edges', () => {
    const graph = new CookDependencyGraph();
    graph.replaceDependencies('shader://lighting', ['shader://math']);

    expect(() => graph.replaceDependencies('shader://math', ['shader://lighting'])).toThrow(
      'Cook dependency cycle: shader://lighting -> shader://math -> shader://lighting'
    );
    expect(graph.dependenciesOf('shader://math')).toEqual([]);
    expect(graph.invalidate('shader://math')).toEqual(['shader://math', 'shader://lighting']);
  });

  test('rejects a direct self-dependency loop with deterministic diagnostics', () => {
    const graph = new CookDependencyGraph();

    expect(() => graph.replaceDependencies('shader://self', ['shader://self'])).toThrow(
      'Cook dependency cycle: shader://self -> shader://self'
    );
    expect(graph.dependenciesOf('shader://self')).toEqual([]);
  });

  test('preserves topological ordering in diamond DAG where BFS or lexicographical order would fail', () => {
    const graph = new CookDependencyGraph();
    // material://0_consumer comes alphabetically before shader://lighting, and depends on both math and lighting.
    // In BFS, material://0_consumer would be queued and visited before shader://lighting.
    // Topological sort guarantees shader://lighting is visited before material://0_consumer.
    graph.replaceDependencies('shader://lighting', ['shader://math']);
    graph.replaceDependencies('material://0_consumer', ['shader://math', 'shader://lighting']);

    expect(graph.invalidate('shader://math')).toEqual([
      'shader://math',
      'shader://lighting',
      'material://0_consumer'
    ]);
  });

  test('preserves topological ordering in multi-path cross-layer DAG', () => {
    const graph = new CookDependencyGraph();
    // A -> B -> D, A -> C -> D, A -> D
    graph.replaceDependencies('shader://b', ['shader://a']);
    graph.replaceDependencies('shader://c', ['shader://a']);
    graph.replaceDependencies('shader://0_final', ['shader://a', 'shader://b', 'shader://c']);

    expect(graph.invalidate('shader://a')).toEqual([
      'shader://a',
      'shader://b',
      'shader://c',
      'shader://0_final'
    ]);
  });
});
