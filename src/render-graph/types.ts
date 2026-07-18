/**
 * Logical RenderGraph identities. These values deliberately carry no native
 * backend object: they are valid only for the graph that created them.
 */
export interface TextureHandle {
  readonly kind: 'texture';
  readonly graphId: number;
  readonly resourceId: number;
  readonly version: number;
}

export interface BufferHandle {
  readonly kind: 'buffer';
  readonly graphId: number;
  readonly resourceId: number;
  readonly version: number;
}

export type GraphHandle = TextureHandle | BufferHandle;
export type GraphResourceKind = GraphHandle['kind'];

export interface PassToken {
  readonly kind: 'pass';
  readonly graphId: number;
  readonly passId: number;
}

export interface TextureRange {
  readonly baseMipLevel: number;
  readonly mipLevelCount: number;
  readonly baseArrayLayer: number;
  readonly arrayLayerCount: number;
  readonly aspect: 'all' | 'depth-only' | 'stencil-only';
}

export interface BufferRange {
  readonly offset: number;
  readonly size: number;
}

export type TextureReadUsage = 'sampled' | 'copy-src' | 'storage-read';
export type TextureWriteUsage =
  'color-attachment' | 'depth-stencil-attachment' | 'copy-dst' | 'storage-write';
export type TextureUsage = TextureReadUsage | TextureWriteUsage;

export type BufferReadUsage =
  'uniform' | 'vertex' | 'index' | 'indirect' | 'copy-src' | 'storage-read';
export type BufferWriteUsage = 'copy-dst' | 'storage-write' | 'query-resolve';
export type BufferUsage = BufferReadUsage | BufferWriteUsage;

export interface TextureDescriptor {
  readonly label?: string;
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
  readonly mipLevelCount: number;
  readonly sampleCount: number;
  readonly format: string;
  readonly usage: readonly TextureUsage[];
}

export interface BufferDescriptor {
  readonly label?: string;
  readonly size: number;
  readonly usage: readonly BufferUsage[];
}

export type ExternalResourceState = TextureUsage | BufferUsage | 'undefined';

/** Opaque authoring token for a resource acquired outside the graph. */
export interface ExternalAcquireToken {
  readonly kind: 'external-acquire';
  readonly id: string;
}

export type GraphResourceOrigin =
  | { readonly kind: 'transient' }
  | {
      readonly kind: 'imported';
      readonly initialState: ExternalResourceState;
      readonly acquire: ExternalAcquireToken;
    }
  | { readonly kind: 'history'; readonly key: string; readonly slots: number };

export function isGraphHandle(value: unknown): value is GraphHandle {
  if (!isRecord(value) || !Object.isFrozen(value)) return false;
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
