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

export interface GraphResourceCreateOptions {
  readonly origin?: GraphResourceOrigin;
  readonly historyValid?: boolean;
}
