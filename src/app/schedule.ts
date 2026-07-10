import type { World } from '../ecs/world';
import type { ScheduleLabel, System, SystemDescriptor, SystemRegistration } from './types';
import { isPromiseLike } from './utils';

/**
 * Representation of a system in the scheduler graph.
 * Couples system execution pointers with metadata and ordering directives.
 */
interface SystemNode {
  id: string;
  run: System;
  before: readonly string[];
  after: readonly string[];
  optionalBefore: readonly string[];
  optionalAfter: readonly string[];
  runIf?: (world: World) => boolean;
}

/**
 * Stage scheduler that organizes systems into an execution sequence.
 * Computes execution ordering topologically using specified dependency parameters.
 */
export class Schedule {
  readonly label: ScheduleLabel;

  private readonly systems: SystemNode[] = [];
  private executionOrder: SystemNode[] = [];
  private isDirty = true;
  private nextSystemId = 0;

  constructor(label: ScheduleLabel) {
    this.label = label;
  }

  addSystem(descriptor: SystemDescriptor | System): SystemRegistration {
    const node = this.createNode(descriptor);
    if (this.systems.some((system) => system.id === node.id)) {
      throw new Error(`System "${node.id}" already exists in schedule "${this.label}".`);
    }

    this.systems.push(node);
    this.isDirty = true;
    return { schedule: this.label, id: node.id };
  }

  removeSystem(registration: SystemRegistration): boolean {
    if (registration.schedule !== this.label) {
      return false;
    }
    const index = this.systems.findIndex((system) => system.id === registration.id);
    if (index < 0) {
      return false;
    }
    this.systems.splice(index, 1);
    this.isDirty = true;
    return true;
  }

  /**
   * Executes all systems sequentially in topological order.
   * Awaits any asynchronous systems. Used for startup phases.
   */
  async run(world: World): Promise<void> {
    const executionOrder = this.getExecutionOrder();

    for (const node of executionOrder) {
      if (node.runIf && !node.runIf(world)) {
        continue;
      }
      await node.run(world);
    }
  }

  /**
   * Executes all systems synchronously. Throws if any system returns a Promise.
   * Used for high-frequency frame loops to guarantee zero promise/microtask allocations.
   */
  runSync(world: World, kind: 'startup' | 'frame' = 'frame'): void {
    const executionOrder = this.getExecutionOrder();

    for (const node of executionOrder) {
      if (node.runIf && !node.runIf(world)) {
        continue;
      }

      const result = node.run(world);
      if (isPromiseLike(result)) {
        throw new Error(
          `Async system "${node.id}" cannot run in ${kind} schedule "${this.label}".`
        );
      }
    }
  }

  private createNode(descriptor: SystemDescriptor | System): SystemNode {
    if (typeof descriptor === 'function') {
      const id = `system_${this.nextSystemId++}`;
      return {
        id,
        run: descriptor,
        before: [],
        after: [],
        optionalBefore: [],
        optionalAfter: []
      };
    }

    if (descriptor.id.trim() === '') {
      throw new Error(`Schedule "${this.label}" requires a non-empty system id.`);
    }
    const node: SystemNode = {
      id: descriptor.id,
      run: descriptor.run,
      before: descriptor.before ?? [],
      after: descriptor.after ?? [],
      optionalBefore: descriptor.optionalBefore ?? [],
      optionalAfter: descriptor.optionalAfter ?? []
    };

    if (descriptor.runIf) {
      node.runIf = descriptor.runIf;
    }

    return node;
  }

  /**
   * Performs a topological sort (Kahn's algorithm) based on before/after constraints.
   * Maps user-facing target names to internal unique ids to assemble graph edges.
   */
  private computeExecutionOrder(): SystemNode[] {
    const nodeMap = new Map<string, SystemNode>();
    const dependents = new Map<string, Set<string>>();
    const inDegree = new Map<string, number>();

    // Index systems by their unique internal ID.
    for (const node of this.systems) {
      nodeMap.set(node.id, node);
      dependents.set(node.id, new Set());
      inDegree.set(node.id, 0);
    }

    const addEdge = (from: string, to: string): void => {
      if (!nodeMap.has(from) || !nodeMap.has(to)) {
        return;
      }

      const edges = dependents.get(from);
      if (!edges || edges.has(to)) {
        return;
      }

      edges.add(to);
      inDegree.set(to, (inDegree.get(to) ?? 0) + 1);
    };

    for (const node of this.systems) {
      for (const target of node.before) {
        this.assertOrderingTarget(node.id, target, nodeMap);
        addEdge(node.id, target);
      }
      for (const dependency of node.after) {
        this.assertOrderingTarget(node.id, dependency, nodeMap);
        addEdge(dependency, node.id);
      }
      for (const target of node.optionalBefore) {
        if (nodeMap.has(target)) {
          addEdge(node.id, target);
        }
      }
      for (const dependency of node.optionalAfter) {
        if (nodeMap.has(dependency)) {
          addEdge(dependency, node.id);
        }
      }
    }

    const queue = this.systems
      .filter((node) => inDegree.get(node.id) === 0)
      .map((node) => node.id);
    const ordered: SystemNode[] = [];

    while (queue.length > 0) {
      const name = queue.shift();
      if (!name) {
        continue;
      }

      const node = nodeMap.get(name);
      if (node) {
        ordered.push(node);
      }

      for (const dependent of dependents.get(name) ?? []) {
        const nextDegree = (inDegree.get(dependent) ?? 0) - 1;
        inDegree.set(dependent, nextDegree);
        if (nextDegree === 0) {
          queue.push(dependent);
        }
      }
    }

    if (ordered.length !== this.systems.length) {
      const cycle = findCyclePath(this.systems.map((node) => node.id), dependents);
      throw new Error(`Schedule "${this.label}" contains a cycle: ${cycle.join(' -> ')}.`);
    }

    return ordered;
  }

  private getExecutionOrder(): SystemNode[] {
    if (this.isDirty) {
      this.executionOrder = this.computeExecutionOrder();
      this.isDirty = false;
    }

    return this.executionOrder;
  }

  private assertOrderingTarget(
    systemId: string,
    target: string,
    nodeMap: ReadonlyMap<string, SystemNode>
  ): void {
    if (!nodeMap.has(target)) {
      throw new Error(
        `Schedule "${this.label}" system "${systemId}" references missing ordering target "${target}".`
      );
    }
  }
}

function findCyclePath(
  nodeIds: readonly string[],
  dependents: ReadonlyMap<string, ReadonlySet<string>>
): string[] {
  const visited = new Set<string>();
  const active = new Set<string>();
  const path: string[] = [];

  const visit = (nodeId: string): string[] | undefined => {
    visited.add(nodeId);
    active.add(nodeId);
    path.push(nodeId);
    for (const dependent of dependents.get(nodeId) ?? []) {
      if (!visited.has(dependent)) {
        const cycle = visit(dependent);
        if (cycle) {
          return cycle;
        }
      } else if (active.has(dependent)) {
        const start = path.indexOf(dependent);
        return [...path.slice(start), dependent];
      }
    }
    path.pop();
    active.delete(nodeId);
    return undefined;
  };

  for (const nodeId of nodeIds) {
    if (!visited.has(nodeId)) {
      const cycle = visit(nodeId);
      if (cycle) {
        return cycle;
      }
    }
  }
  return [];
}
