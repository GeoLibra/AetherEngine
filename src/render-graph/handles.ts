import type { GraphHandle, GraphResourceKind } from './types';

type GraphHandleForKind<K extends GraphResourceKind> = Extract<GraphHandle, { readonly kind: K }>;

const GRAPH_HANDLES = new WeakSet<object>();

/** @internal Only graph implementation modules may mint logical handles. */
export function createGraphHandle<K extends GraphResourceKind>(
  kind: K,
  graphId: number,
  resourceId: number,
  version: number
): GraphHandleForKind<K> {
  assertHandleId(graphId, 'graphId');
  assertHandleId(resourceId, 'resourceId');
  assertHandleId(version, 'version');
  const handle = Object.freeze({ kind, graphId, resourceId, version });
  GRAPH_HANDLES.add(handle);
  return handle as GraphHandleForKind<K>;
}

export function isGraphHandle(value: unknown): value is GraphHandle {
  if (!isRecord(value) || !Object.isFrozen(value) || !GRAPH_HANDLES.has(value)) return false;
  if (value.kind !== 'texture' && value.kind !== 'buffer') return false;
  return (
    isNonNegativeInteger(value.graphId) &&
    isNonNegativeInteger(value.resourceId) &&
    isNonNegativeInteger(value.version)
  );
}

/**
 * Builder and executor boundaries use this single guard so malformed, foreign,
 * kind-mismatched, and superseded handles cannot enter graph state.
 */
export function assertGraphHandle(
  value: unknown,
  graphId: number,
  expectedKind?: GraphResourceKind,
  currentVersion?: number
): asserts value is GraphHandle {
  if (!isGraphHandle(value)) throw new Error('Invalid render graph handle.');
  if (expectedKind !== undefined && value.kind !== expectedKind) {
    throw new Error(`Expected a ${expectedKind} render graph handle.`);
  }
  if (value.graphId !== graphId) throw new Error('Render graph handle belongs to a foreign graph.');
  if (currentVersion !== undefined && value.version !== currentVersion) {
    throw new Error('Render graph handle is stale.');
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function assertHandleId(value: number, name: string): void {
  if (!isNonNegativeInteger(value)) {
    throw new Error(`Render graph handle ${name} must be a non-negative integer.`);
  }
}
