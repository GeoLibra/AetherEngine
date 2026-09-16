import type {
  BufferUsage,
  ExternalResourceState,
  GraphResourceKind,
  TextureUsage
} from './render-graph-types';
import type { GraphRange } from '../ranges';
import type { GraphPassDeclaration } from './graph-snapshot-types';

export type RenderGraphHazardKind = 'raw' | 'war' | 'waw';

export interface RenderGraphHazardEdge {
  readonly kind: RenderGraphHazardKind;
  readonly fromPassId: number;
  readonly toPassId: number;
  readonly resourceId: number;
  readonly resourceKind: GraphResourceKind;
  readonly version: number;
  readonly range: GraphRange;
  readonly fallback: boolean;
}

export interface RenderGraphHazardCounters {
  readonly accessesExamined: number;
  readonly overlapComparisons: number;
  readonly wholeResourceFallbacks: number;
}

export interface RenderGraphSemanticEdge {
  readonly kind: 'semantic';
  readonly fromPassId: number;
  readonly toPassId: number;
}

export type CompiledRenderGraphEdge = RenderGraphHazardEdge | RenderGraphSemanticEdge;

export interface CulledRenderGraphPass {
  readonly passId: number;
  readonly id: string;
  readonly reason: 'unreachable-from-root';
}

export interface CompiledRenderGraphCounters extends RenderGraphHazardCounters {
  readonly totalPasses: number;
  readonly retainedPasses: number;
  readonly culledPasses: number;
  readonly hazardEdges: number;
  readonly semanticEdges: number;
  readonly edgeCount: number;
}

export interface CompiledRenderGraph {
  readonly graphId: number;
  readonly retainedPasses: readonly GraphPassDeclaration[];
  readonly order: readonly number[];
  readonly edges: readonly CompiledRenderGraphEdge[];
  readonly rootPassIds: readonly number[];
  readonly culledPasses: readonly CulledRenderGraphPass[];
  readonly counters: CompiledRenderGraphCounters;
}

export interface ResourceLifetime {
  readonly resourceId: number;
  readonly resourceKind: GraphResourceKind;
  readonly firstUse: number;
  readonly lastUse: number;
  readonly firstPassId: number;
  readonly lastPassId: number;
  readonly ranges: readonly GraphRange[];
}

export type AliasRejectionReason =
  | 'overlapping-lifetime'
  | 'descriptor-incompatible'
  | 'origin-not-transient'
  | 'backend-alignment'
  | 'submission-pending';

export interface AliasRejection {
  readonly allocationId: number | null;
  readonly againstResourceId: number;
  readonly reason: AliasRejectionReason;
}

export interface AliasDecision {
  readonly resourceId: number;
  readonly allocationId: number | null;
  readonly aliasedWithResourceIds: readonly number[];
  readonly rejections: readonly AliasRejection[];
}

export interface ResourceAliasPlan {
  readonly decisions: readonly AliasDecision[];
  readonly allocationCount: number;
  readonly aliasGroupCount: number;
}

export type HistoryInvalidationReason =
  | 'new'
  | 'generation-changed'
  | 'resize'
  | 'abi-changed'
  | 'policy-changed'
  | 'explicit-reset'
  | 'view-destroyed'
  | 'submission-failed'
  | 'device-lost';

export type PortableResourceUsage = TextureUsage | BufferUsage | ExternalResourceState | 'present';

export interface PortableTransition {
  readonly resourceId: number;
  readonly resourceKind: GraphResourceKind;
  readonly range: GraphRange;
  readonly beforeUsage: PortableResourceUsage;
  readonly afterUsage: PortableResourceUsage;
  readonly fromPassId: number | null;
  readonly toPassId: number;
  readonly submissionIndex: number;
}
