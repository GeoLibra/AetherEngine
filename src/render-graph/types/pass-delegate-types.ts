import type { GraphRange } from '../ranges';
import type { GraphAccess, GraphTerminal } from './graph-snapshot-types';
import type {
  BufferDescriptor,
  BufferHandle,
  BufferRange,
  BufferReadUsage,
  BufferWriteUsage,
  ExternalResourceState,
  GraphHandle,
  GraphResourceCreateOptions,
  PassToken,
  TextureDescriptor,
  TextureHandle,
  TextureRange,
  TextureReadUsage,
  TextureWriteUsage
} from './render-graph-types';
import type { SurfaceFrameToken } from './surface-frame-types';

/**
 * Internal delegate interface connecting pass-builder recording scopes
 * to the owning RenderGraphBuilder instance.
 */
export interface RenderGraphPassContextDelegate {
  readonly graphId: number;
  createTexture(descriptor: TextureDescriptor, options?: GraphResourceCreateOptions): TextureHandle;
  createBuffer(descriptor: BufferDescriptor, options?: GraphResourceCreateOptions): BufferHandle;
  descriptorFor(handle: GraphHandle): TextureDescriptor | BufferDescriptor;
  normalizeRange(handle: GraphHandle, range?: TextureRange | BufferRange): GraphRange;
  declareRead(
    passId: number,
    handle: GraphHandle,
    usage: TextureReadUsage | BufferReadUsage,
    expectedKind: GraphHandle['kind'],
    range?: TextureRange | BufferRange
  ): GraphAccess;
  declareWrite(
    passId: number,
    handle: GraphHandle,
    usage: TextureWriteUsage | BufferWriteUsage,
    expectedKind: GraphHandle['kind'],
    range?: TextureRange | BufferRange
  ): GraphAccess;
  declareTerminal(terminal: GraphTerminal): void;
  declareAfter(fromPass: PassToken, toPassId: number): void;
  validatePresentBinding(handle: TextureHandle, surfaceFrame: SurfaceFrameToken): void;
  validateExportState(handle: GraphHandle, finalState: ExternalResourceState): void;
}
