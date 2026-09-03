import type {
  RenderArtifactReferenceBundle,
  ShaderPackageHmrPublisher
} from '../../render-artifact-package';
import type { CookArtifactPublisher } from '../artifact-publisher';
import type { CookNodeId } from './cook-types';

/** Complete native-cooker result ready for package validation and durable publication. */
export interface ShaderCookResult {
  readonly bundle: RenderArtifactReferenceBundle;
  readonly dependencies: readonly CookNodeId[];
  readonly inputHashes: readonly string[];
  readonly toolchainVersion: string;
}

/** External development cooker boundary; browser/runtime code does not implement this port. */
export interface ShaderCookerPort {
  cook(nodeId: CookNodeId, revision: number): Promise<ShaderCookResult>;
}

/** Dependencies required by the shader recook coordinator. */
export interface ShaderRecookCoordinatorOptions {
  readonly artifactPublisher: CookArtifactPublisher;
  readonly cooker: ShaderCookerPort;
}

/** Registration for one stable shader package node. */
export interface ShaderRecookRegistration {
  readonly nodeId: CookNodeId;
  readonly dependencies: readonly CookNodeId[];
  readonly publisher: ShaderPackageHmrPublisher;
}

/** Observable outcome for one node affected by a source revision. */
export type ShaderRecookResult = Readonly<{
  nodeId: CookNodeId;
  revision: number;
  status: 'staged' | 'stale' | 'failed';
  message?: string;
}>;
