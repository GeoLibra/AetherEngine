import { CookDependencyGraph } from '../../src/assets/cook';

export interface CookDependencyChainFixture {
  readonly graph: CookDependencyGraph;
  readonly nodeIds: readonly string[];
}

export function createCookDependencyChainFixture(count: number): CookDependencyChainFixture {
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error('Cook dependency fixture count must be a positive integer.');
  }
  const graph = new CookDependencyGraph();
  const nodeIds = Array.from({ length: count }, (_, index) => `asset://node/${index}`);
  for (let index = 0; index < count; index++) {
    graph.replaceDependencies(nodeIds[index]!, index === 0 ? [] : [nodeIds[index - 1]!]);
  }
  return Object.freeze({ graph, nodeIds: Object.freeze(nodeIds) });
}

export function invalidateCookDependencyChain(
  fixture: CookDependencyChainFixture,
  changedIndex: number
): Readonly<{ invalidated: readonly string[]; visitedNodes: number }> {
  const changed = fixture.nodeIds[changedIndex];
  if (!changed) throw new Error('Cook dependency changed index is outside the fixture.');
  const invalidated = fixture.graph.invalidate(changed);
  return Object.freeze({ invalidated, visitedNodes: invalidated.length });
}
