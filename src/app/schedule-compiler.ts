import type { AccessToken, System, SystemDescriptor, SystemSetDescriptor } from './types';

/** Internal compiled system node representation. */
export interface CompiledSystemNode {
  readonly id: string;
  readonly run: System;
  readonly inSet?: string | undefined;
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly optionalBefore: readonly string[];
  readonly optionalAfter: readonly string[];
  readonly reads: readonly AccessToken[];
  readonly writes: readonly AccessToken[];
  readonly runIf?: ((world: any) => boolean) | undefined;
  readonly ownerPlugin?: string | undefined;
  readonly registrationIndex: number;
}

/** Internal compiled system set representation. */
export interface CompiledSetNode {
  readonly id: string;
  readonly before: readonly string[];
  readonly after: readonly string[];
  readonly runIf?: ((world: any) => boolean) | undefined;
  readonly ownerPlugin?: string | undefined;
  readonly registrationIndex: number;
}

interface GraphNode {
  readonly key: string;
  readonly isVirtual: boolean;
  readonly systemNode?: CompiledSystemNode;
  readonly setId?: string;
  readonly registrationIndex: number;
}

/**
 * Builds virtual graph nodes for sets and systems, adds edges according to ordering constraints,
 * and sorts topologically using Kahn's algorithm with lowest registration index tie-breaking.
 */
export function compileScheduleOrder(
  scheduleLabel: string,
  systems: readonly CompiledSystemNode[],
  sets: readonly CompiledSetNode[]
): CompiledSystemNode[] {
  const nodeMap = new Map<string, GraphNode>();
  const setMap = new Map<string, CompiledSetNode>();
  const setMembers = new Map<string, string[]>();

  // Index declared sets
  for (const s of sets) {
    if (setMap.has(s.id)) {
      throw new Error(`Schedule "${scheduleLabel}" already contains set "${s.id}".`);
    }
    setMap.set(s.id, s);
    setMembers.set(s.id, []);

    // Virtual entry and exit nodes for each set
    const entryKey = `set:entry:${s.id}`;
    const exitKey = `set:exit:${s.id}`;
    nodeMap.set(entryKey, {
      key: entryKey,
      isVirtual: true,
      setId: s.id,
      registrationIndex: s.registrationIndex
    });
    nodeMap.set(exitKey, {
      key: exitKey,
      isVirtual: true,
      setId: s.id,
      registrationIndex: s.registrationIndex
    });
  }

  // Index systems
  for (const sys of systems) {
    if (nodeMap.has(sys.id) || setMap.has(sys.id)) {
      const ownerInfo = sys.ownerPlugin ? ` (owner: "${sys.ownerPlugin}")` : '';
      throw new Error(
        `System "${sys.id}"${ownerInfo} already exists in schedule "${scheduleLabel}".`
      );
    }
    nodeMap.set(sys.id, {
      key: sys.id,
      isVirtual: false,
      systemNode: sys,
      registrationIndex: sys.registrationIndex
    });

    if (sys.inSet !== undefined) {
      const members = setMembers.get(sys.inSet);
      if (!members) {
        const ownerInfo = sys.ownerPlugin ? ` from plugin "${sys.ownerPlugin}"` : '';
        throw new Error(
          `Schedule "${scheduleLabel}" system "${sys.id}"${ownerInfo} references undeclared set "${sys.inSet}".`
        );
      }
      members.push(sys.id);
    }
  }

  const dependents = new Map<string, Set<string>>();
  const inDegree = new Map<string, number>();

  for (const key of nodeMap.keys()) {
    dependents.set(key, new Set());
    inDegree.set(key, 0);
  }

  const addEdge = (fromKey: string, toKey: string): void => {
    if (!nodeMap.has(fromKey) || !nodeMap.has(toKey)) return;
    const targets = dependents.get(fromKey);
    if (!targets || targets.has(toKey)) return;
    targets.add(toKey);
    inDegree.set(toKey, (inDegree.get(toKey) ?? 0) + 1);
  };

  // Internal set boundary edges: entry -> members -> exit, or entry -> exit if empty
  for (const [setId, members] of setMembers.entries()) {
    const entryKey = `set:entry:${setId}`;
    const exitKey = `set:exit:${setId}`;
    addEdge(entryKey, exitKey);
    for (const memberId of members) {
      addEdge(entryKey, memberId);
      addEdge(memberId, exitKey);
    }
  }

  // Apply constraints
  applySetConstraints(scheduleLabel, sets, setMap, nodeMap, addEdge);
  applySystemConstraints(scheduleLabel, systems, setMap, nodeMap, addEdge);

  return executeKahnSort(scheduleLabel, nodeMap, dependents, inDegree);
}

function applySetConstraints(
  schedule: string,
  sets: readonly CompiledSetNode[],
  setMap: ReadonlyMap<string, CompiledSetNode>,
  nodeMap: ReadonlyMap<string, GraphNode>,
  addEdge: (from: string, to: string) => void
): void {
  for (const s of sets) {
    const sExit = `set:exit:${s.id}`;
    const sEntry = `set:entry:${s.id}`;

    for (const target of s.before) {
      if (setMap.has(target)) {
        addEdge(sExit, `set:entry:${target}`);
      } else if (nodeMap.has(target)) {
        addEdge(sExit, target);
      } else {
        const ownerInfo = s.ownerPlugin ? ` (owner: "${s.ownerPlugin}")` : '';
        throw new Error(
          `Schedule "${schedule}" set "${s.id}"${ownerInfo} references missing ordering target "${target}".`
        );
      }
    }

    for (const dep of s.after) {
      if (setMap.has(dep)) {
        addEdge(`set:exit:${dep}`, sEntry);
      } else if (nodeMap.has(dep)) {
        addEdge(dep, sEntry);
      } else {
        const ownerInfo = s.ownerPlugin ? ` (owner: "${s.ownerPlugin}")` : '';
        throw new Error(
          `Schedule "${schedule}" set "${s.id}"${ownerInfo} references missing ordering target "${dep}".`
        );
      }
    }
  }
}

function applySystemConstraints(
  schedule: string,
  systems: readonly CompiledSystemNode[],
  setMap: ReadonlyMap<string, CompiledSetNode>,
  nodeMap: ReadonlyMap<string, GraphNode>,
  addEdge: (from: string, to: string) => void
): void {
  for (const sys of systems) {
    for (const target of sys.before) {
      if (setMap.has(target)) {
        addEdge(sys.id, `set:entry:${target}`);
      } else if (nodeMap.has(target)) {
        addEdge(sys.id, target);
      } else {
        const ownerInfo = sys.ownerPlugin ? ` (owner: "${sys.ownerPlugin}")` : '';
        throw new Error(
          `Schedule "${schedule}" system "${sys.id}"${ownerInfo} references missing ordering target "${target}".`
        );
      }
    }

    for (const dep of sys.after) {
      if (setMap.has(dep)) {
        addEdge(`set:exit:${dep}`, sys.id);
      } else if (nodeMap.has(dep)) {
        addEdge(dep, sys.id);
      } else {
        const ownerInfo = sys.ownerPlugin ? ` (owner: "${sys.ownerPlugin}")` : '';
        throw new Error(
          `Schedule "${schedule}" system "${sys.id}"${ownerInfo} references missing ordering target "${dep}".`
        );
      }
    }

    for (const target of sys.optionalBefore) {
      if (setMap.has(target)) addEdge(sys.id, `set:entry:${target}`);
      else if (nodeMap.has(target)) addEdge(sys.id, target);
    }

    for (const dep of sys.optionalAfter) {
      if (setMap.has(dep)) addEdge(`set:exit:${dep}`, sys.id);
      else if (nodeMap.has(dep)) addEdge(dep, sys.id);
    }
  }
}

function executeKahnSort(
  schedule: string,
  nodeMap: ReadonlyMap<string, GraphNode>,
  dependents: ReadonlyMap<string, Set<string>>,
  inDegree: Map<string, number>
): CompiledSystemNode[] {
  // Eligible candidates pool with lowest registration index tie-breaking
  const readyNodes: GraphNode[] = [];
  for (const [key, degree] of inDegree.entries()) {
    if (degree === 0) {
      const node = nodeMap.get(key);
      if (node) readyNodes.push(node);
    }
  }

  const result: CompiledSystemNode[] = [];
  let visitedCount = 0;

  while (readyNodes.length > 0) {
    // Deterministic tie-breaking: pick node with smallest registrationIndex
    let minIdx = 0;
    for (let i = 1; i < readyNodes.length; i++) {
      const nodeI = readyNodes[i];
      const nodeMin = readyNodes[minIdx];
      if (nodeI && nodeMin && nodeI.registrationIndex < nodeMin.registrationIndex) {
        minIdx = i;
      }
    }
    const current = readyNodes.splice(minIdx, 1)[0];
    if (!current) continue;
    visitedCount++;

    if (!current.isVirtual && current.systemNode) {
      result.push(current.systemNode);
    }

    for (const dependentKey of dependents.get(current.key) ?? []) {
      const nextDegree = (inDegree.get(dependentKey) ?? 0) - 1;
      inDegree.set(dependentKey, nextDegree);
      if (nextDegree === 0) {
        const depNode = nodeMap.get(dependentKey);
        if (depNode) readyNodes.push(depNode);
      }
    }
  }

  if (visitedCount !== nodeMap.size) {
    const cycle = findCyclePath([...nodeMap.keys()], dependents);
    throw new Error(`Schedule "${schedule}" contains a cycle: ${cycle.join(' -> ')}.`);
  }

  return Object.freeze(result) as CompiledSystemNode[];
}

function findCyclePath(
  allKeys: readonly string[],
  dependents: ReadonlyMap<string, ReadonlySet<string>>
): string[] {
  const visited = new Set<string>();
  const active = new Set<string>();
  const path: string[] = [];

  const visit = (key: string): string[] | undefined => {
    visited.add(key);
    active.add(key);
    path.push(key);
    for (const dep of dependents.get(key) ?? []) {
      if (!visited.has(dep)) {
        const found = visit(dep);
        if (found) return found;
      } else if (active.has(dep)) {
        const start = path.indexOf(dep);
        return [...path.slice(start), dep];
      }
    }
    path.pop();
    active.delete(key);
    return undefined;
  };

  for (const key of allKeys) {
    if (!visited.has(key)) {
      const cycle = visit(key);
      if (cycle) return cycle;
    }
  }
  return ['unknown cycle'];
}
