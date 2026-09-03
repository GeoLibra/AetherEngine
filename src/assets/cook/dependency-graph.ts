import type { CookNodeId } from './types';

/**
 * Tracks cook dependencies and their reverse invalidation edges.
 *
 * Edge replacement is transactional: a cycle leaves the previously published graph unchanged.
 */
export class CookDependencyGraph {
  readonly #dependencies = new Map<CookNodeId, ReadonlySet<CookNodeId>>();
  readonly #dependents = new Map<CookNodeId, Set<CookNodeId>>();

  /** Replaces one node's complete dependency set after validating that it remains acyclic. */
  replaceDependencies(nodeInput: CookNodeId, dependencyInputs: readonly CookNodeId[]): void {
    const node = validateNodeId(nodeInput);
    const dependencies = new Set(dependencyInputs.map(validateNodeId));
    const cycle = this.#findCycle(node, dependencies);
    if (cycle) {
      throw new Error(`Cook dependency cycle: ${cycle.join(' -> ')}`);
    }

    const previous = this.#dependencies.get(node) ?? EMPTY_NODE_SET;
    for (const dependency of previous) {
      this.#dependents.get(dependency)?.delete(node);
    }
    this.#dependencies.set(node, dependencies);
    for (const dependency of dependencies) {
      const dependents = this.#dependents.get(dependency) ?? new Set<CookNodeId>();
      dependents.add(node);
      this.#dependents.set(dependency, dependents);
    }
  }

  /** Returns the stable, sorted dependency snapshot for a node. */
  dependenciesOf(nodeInput: CookNodeId): readonly CookNodeId[] {
    const node = validateNodeId(nodeInput);
    return Object.freeze([...(this.#dependencies.get(node) ?? EMPTY_NODE_SET)].sort());
  }

  /** Returns the changed node followed by all transitive dependents in topological dependency order. */
  invalidate(nodeInput: CookNodeId): readonly CookNodeId[] {
    const root = validateNodeId(nodeInput);
    const affected = new Set<CookNodeId>([root]);
    const queue: CookNodeId[] = [root];
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index]!;
      for (const dependent of this.#dependents.get(current) ?? EMPTY_NODE_SET) {
        if (!affected.has(dependent)) {
          affected.add(dependent);
          queue.push(dependent);
        }
      }
    }

    const inDegree = new Map<CookNodeId, number>();
    for (const node of affected) {
      let degree = 0;
      for (const dependency of this.#dependencies.get(node) ?? EMPTY_NODE_SET) {
        if (affected.has(dependency)) degree += 1;
      }
      inDegree.set(node, degree);
    }

    const ready: CookNodeId[] = [];
    for (const [node, degree] of inDegree) {
      if (degree === 0) ready.push(node);
    }
    ready.sort((a, b) => a.localeCompare(b));

    const ordered: CookNodeId[] = [];
    while (ready.length > 0) {
      const current = ready.shift()!;
      ordered.push(current);
      const dependents = [...(this.#dependents.get(current) ?? EMPTY_NODE_SET)].sort((a, b) =>
        a.localeCompare(b)
      );
      for (const dependent of dependents) {
        if (!affected.has(dependent)) continue;
        const nextDegree = (inDegree.get(dependent) ?? 1) - 1;
        inDegree.set(dependent, nextDegree);
        if (nextDegree === 0) {
          const insertIndex = ready.findIndex((item) => item.localeCompare(dependent) > 0);
          if (insertIndex === -1) ready.push(dependent);
          else ready.splice(insertIndex, 0, dependent);
        }
      }
    }

    return Object.freeze(ordered);
  }

  #findCycle(
    node: CookNodeId,
    candidateDependencies: ReadonlySet<CookNodeId>
  ): CookNodeId[] | undefined {
    if (candidateDependencies.has(node)) {
      return [node, node];
    }
    const visited = new Set<CookNodeId>();
    const onStack = new Set<CookNodeId>();
    const path: CookNodeId[] = [];

    const visit = (current: CookNodeId): CookNodeId[] | undefined => {
      if (current === node) {
        return [...path, current, path[0]!];
      }
      if (visited.has(current)) return undefined;
      if (onStack.has(current)) {
        const startIndex = path.indexOf(current);
        return startIndex >= 0 ? [...path.slice(startIndex), current] : undefined;
      }
      onStack.add(current);
      path.push(current);

      const nextDependencies =
        current === node
          ? candidateDependencies
          : (this.#dependencies.get(current) ?? EMPTY_NODE_SET);
      for (const dependency of [...nextDependencies].sort((a, b) => a.localeCompare(b))) {
        const cycle = visit(dependency);
        if (cycle) return cycle;
      }

      path.pop();
      onStack.delete(current);
      visited.add(current);
      return undefined;
    };

    for (const dependency of [...candidateDependencies].sort((a, b) => a.localeCompare(b))) {
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    return undefined;
  }
}

const EMPTY_NODE_SET: ReadonlySet<CookNodeId> = new Set();

function validateNodeId(value: CookNodeId): CookNodeId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Cook node id must be a non-empty string.');
  }
  return value;
}
