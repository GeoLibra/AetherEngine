import type { RHIBuffer, RHISubmission } from '../../rhi/contracts';
import type { AvailablePipelinePhaseItem } from './pipeline-availability-types';
import type {
  MaterialBindGroupCacheResolution,
  RealizedMaterialBindGroups
} from './material-bind-group-types';
import type { PreparedMeshQueueCandidate } from './mesh-queue-types';
import type { RenderEntityId } from '../render-world';
import type { RenderPhaseKind } from '../render-phase';

/** Exact prepared resources required to produce one indexed draw packet. */
export interface PrepareDrawPacketInput {
  readonly availability: AvailablePipelinePhaseItem;
  readonly binding: MaterialBindGroupCacheResolution;
  readonly candidate: PreparedMeshQueueCandidate;
}

export type PreparedDrawPacketSkipCode =
  | 'draw-entity-mismatch'
  | 'binding-key-mismatch'
  | 'device-generation-stale'
  | 'indexed-draw-required'
  | 'invalid-draw-range'
  | 'draw-lease-released';

/** Structured Queue rejection produced before any ownership is transferred. */
export interface PreparedDrawPacketSkip {
  readonly status: 'skipped';
  readonly entity: RenderEntityId;
  readonly reason: 'incompatible-draw-packet';
  readonly code: PreparedDrawPacketSkipCode;
  readonly message: string;
}

/**
 * Immutable indexed draw facts with borrowed local ownership.
 *
 * Mesh and material leases remain owned by the originating queue resolution. `retain` transfers
 * all four resource domains to the accepted submission; `release` ends only the packet's local
 * pipeline and binding ownership.
 */
export interface PreparedDrawPacket {
  readonly entity: RenderEntityId;
  readonly phase: RenderPhaseKind;
  readonly pipelineKey: string;
  readonly bindingKey: string;
  readonly pipeline: AvailablePipelinePhaseItem['pipeline'];
  readonly bindingSet: RealizedMaterialBindGroups;
  readonly vertexBuffers: readonly RHIBuffer[];
  readonly indexBuffer: RHIBuffer;
  readonly indexFormat: 'uint16' | 'uint32';
  readonly firstIndex: number;
  readonly indexCount: number;
  readonly released: boolean;
  retain(submission: RHISubmission): void;
  release(): void;
}

export type PreparedDrawPacketResult =
  { readonly status: 'ready'; readonly packet: PreparedDrawPacket } | PreparedDrawPacketSkip;
