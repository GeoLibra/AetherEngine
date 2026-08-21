import type { PreparedAssetLease } from '../prepared-assets';
import type { PreparedMesh } from '../mesh-prepare';
import type { RenderEntityId, RenderRevision } from '../render-world';
import type { ViewVisibilitySnapshot } from '../visibility/types';
import type { PreparedMaterialCompatibility } from './material-pipeline-compatibility-types';

export type MeshQueueSkipCode =
  | 'missing-render-fact'
  | 'mesh-prepare-pending'
  | 'material-prepare-pending'
  | 'invalid-submesh'
  | 'missing-material-slot';

export interface MeshQueueSkip {
  readonly entity: RenderEntityId;
  readonly reason: 'prepare-pending' | 'missing-resource' | 'incompatible-pipeline';
  readonly code: MeshQueueSkipCode;
}

export interface PreparedMeshQueueCandidate {
  readonly entity: RenderEntityId;
  readonly depthRange: readonly [number, number];
  readonly submesh: number;
  readonly mesh: PreparedAssetLease<PreparedMesh>;
  readonly material: PreparedAssetLease<PreparedMaterialCompatibility>;
}

export interface MeshQueueResolution {
  readonly candidates: readonly PreparedMeshQueueCandidate[];
  readonly skipped: readonly MeshQueueSkip[];
  readonly disposed: boolean;
  dispose(): void;
}

export interface ResolveMeshQueueInput {
  readonly revision: RenderRevision;
  readonly visibility: ViewVisibilitySnapshot;
  readonly deviceGeneration: number;
  readonly featurePolicyKey: string;
  readonly meshAbiVersion: string;
  readonly materialAbiVersion: string;
}
