import type { World } from '../ecs/world';
import type { ScheduleLabel, System, SystemDescriptor } from './types';
import { isPromiseLike } from './utils';

/**
 * Representation of a system in the scheduler graph.
 * Couples system execution pointers with metadata and ordering directives.
 */
interface SystemNode {
  // Unique generated identifier to isolate node in the dependency graph.
  // Resolves name minification conflicts when multiple function systems share compressed names.
  id: string;
  system: System;
  // Optional unique string label to allow referencing in before/after rules.
  name?: string;
  debugName: string;
  before: string[];
  after: string[];
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

  addSystem(descriptor: SystemDescriptor | System): this {
    const node = this.createNode(descriptor);
    if (node.name && this.systems.some((system) => system.name === node.name)) {
      throw new Error(`System "${node.name}" already exists in schedule "${this.label}".`);
    }

    this.systems.push(node);
    this.isDirty = true;
    return this;
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
      await node.system(world);
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

      const result = node.system(world);
      if (isPromiseLike(result)) {
        throw new Error(
          `Async system "${node.debugName}" cannot run in ${kind} schedule "${this.label}".`
        );
      }
    }
  }

  private createNode(descriptor: SystemDescriptor | System): SystemNode {
    // Generate a unique fallback ID to safeguard against function name minification clashes.
    const id = `system_${this.nextSystemId++}`;

    if (typeof descriptor === 'function') {
      return {
        id,
        system: descriptor,
        debugName: descriptor.name || id,
        before: [],
        after: []
      };
    }

    const node: SystemNode = {
      id,
      system: descriptor.system,
      debugName: descriptor.name || descriptor.system.name || id,
      before: descriptor.before ?? [],
      after: descriptor.after ?? []
    };

    if (descriptor.name) {
      node.name = descriptor.name;
    }

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
    const labelMap = new Map<string, string>();
    const dependents = new Map<string, Set<string>>();
    const inDegree = new Map<string, number>();

    // Index systems by their unique internal ID.
    for (const node of this.systems) {
      nodeMap.set(node.id, node);
      if (node.name) {
        labelMap.set(node.name, node.id);
      }
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

    // Resolve dependencies using label mappings.
    for (const node of this.systems) {
      for (const target of node.before) {
        const targetId = labelMap.get(target);
        if (targetId) {
          addEdge(node.id, targetId);
        }
      }
      for (const dependency of node.after) {
        const dependencyId = labelMap.get(dependency);
        if (dependencyId) {
          addEdge(dependencyId, node.id);
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
      throw new Error(`Circular dependency detected in schedule "${this.label}"`);
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
}
