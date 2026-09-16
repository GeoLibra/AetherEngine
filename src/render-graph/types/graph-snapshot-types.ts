import type { GraphRange } from '../ranges';
import type {
  BufferReadUsage,
  BufferWriteUsage,
  ExternalResourceState,
  GraphHandle,
  PassToken,
  TextureHandle,
  TextureReadUsage,
  TextureWriteUsage
} from './render-graph-types';
import type { PassKind } from './typed-pass-types';
import type { SurfaceFrameToken } from './surface-frame-types';
import type {
  ComputePassDeclarationDetails,
  RasterPassDeclarationDetails
} from './pass-declaration-types';
import type { GraphResourceRecord } from './resource-record-types';

export interface GraphReadAccess {
  readonly kind: 'read';
  readonly passId: number;
  readonly handle: GraphHandle;
  readonly usage: TextureReadUsage | BufferReadUsage;
  readonly range: GraphRange;
}

export interface GraphWriteAccess {
  readonly kind: 'write';
  readonly passId: number;
  readonly source: GraphHandle;
  readonly handle: GraphHandle;
  readonly usage: TextureWriteUsage | BufferWriteUsage;
  readonly range: GraphRange;
}

export type GraphAccess = GraphReadAccess | GraphWriteAccess;

export type GraphTerminal =
  | {
      readonly kind: 'export';
      readonly passId: number;
      readonly handle: GraphHandle;
      readonly finalState: ExternalResourceState;
    }
  | {
      readonly kind: 'present';
      readonly passId: number;
      readonly handle: TextureHandle;
      readonly surfaceFrame: SurfaceFrameToken;
    };

export interface SemanticEdge {
  readonly kind: 'after';
  readonly fromPassId: number;
  readonly toPassId: number;
}

export interface GraphPassDeclaration {
  readonly id: string;
  readonly token: PassToken;
  readonly registrationIndex: number;
  readonly passKind: PassKind;
  readonly accesses: readonly GraphAccess[];
  readonly terminals: readonly GraphTerminal[];
  readonly sideEffects: readonly string[];
  readonly rasterDetails?: RasterPassDeclarationDetails;
  readonly computeDetails?: ComputePassDeclarationDetails;
  readonly resources: unknown;
  readonly run: (context: unknown) => void;
}

export interface RenderGraphSnapshot {
  readonly graphId: number;
  readonly resources: readonly GraphResourceRecord[];
  readonly passes: readonly GraphPassDeclaration[];
  readonly terminals: readonly GraphTerminal[];
  readonly semanticEdges: readonly SemanticEdge[];
}
