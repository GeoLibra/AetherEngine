import { decodeCookedShaderPackage } from '../render-artifact-package';
import type {
  ShaderPackageCommitResult,
  ShaderPackageHmrPublisher
} from '../render-artifact-package';
import { CookDependencyGraph } from './dependency-graph';
import type {
  CookCandidateOutput,
  CookNodeId,
  ShaderRecookCoordinatorOptions,
  ShaderRecookRegistration,
  ShaderRecookResult
} from './types';

interface RegisteredShaderNode {
  readonly publisher: ShaderPackageHmrPublisher;
  revision: number;
}

interface StagedFramePublication {
  readonly publisher: ShaderPackageHmrPublisher;
  readonly revision: number;
}

/**
 * Connects source invalidation to an external shader cooker, durable artifacts, and frame-boundary HMR.
 *
 * The coordinator owns revision ordering. Obsolete async completions never reach either persistent or
 * runtime publication, and callers explicitly invoke {@link commitFrame} at their frame boundary.
 */
export class ShaderRecookCoordinator {
  readonly #graph = new CookDependencyGraph();
  readonly #nodes = new Map<CookNodeId, RegisteredShaderNode>();
  readonly #staged = new Map<CookNodeId, StagedFramePublication>();
  readonly #artifactPublisher: ShaderRecookCoordinatorOptions['artifactPublisher'];
  readonly #cooker: ShaderRecookCoordinatorOptions['cooker'];

  constructor(options: ShaderRecookCoordinatorOptions) {
    this.#artifactPublisher = options.artifactPublisher;
    this.#cooker = options.cooker;
  }

  /** Registers a stable shader package and its last-known dependency edges. */
  register(registration: ShaderRecookRegistration): void {
    if (this.#nodes.has(registration.nodeId)) {
      throw new Error(`Shader cook node is already registered: ${registration.nodeId}`);
    }
    this.#graph.replaceDependencies(registration.nodeId, registration.dependencies);
    this.#nodes.set(registration.nodeId, { publisher: registration.publisher, revision: 0 });
  }

  /** Recooks the changed source and every registered transitive dependent in dependency order. */
  async sourceChanged(source: CookNodeId): Promise<readonly ShaderRecookResult[]> {
    const results: ShaderRecookResult[] = [];
    for (const nodeId of this.#graph.invalidate(source)) {
      const node = this.#nodes.get(nodeId);
      if (!node) continue;
      results.push(await this.#recook(nodeId, node));
    }
    return Object.freeze(results);
  }

  /** Atomically exposes every successfully persisted candidate at the caller-owned frame boundary. */
  commitFrame(): readonly ShaderPackageCommitResult[] {
    const results: ShaderPackageCommitResult[] = [];
    for (const { publisher, revision } of this.#staged.values()) {
      results.push(publisher.commit(revision));
    }
    this.#staged.clear();
    return Object.freeze(results);
  }

  async #recook(nodeId: CookNodeId, node: RegisteredShaderNode): Promise<ShaderRecookResult> {
    const revision = ++node.revision;
    try {
      const candidate = await this.#cooker.cook(nodeId, revision);
      if (node.revision !== revision) return stale(nodeId, revision);

      // Decode before mutating either dependency or persistent publication state.
      const decoded = await decodeCookedShaderPackage(candidate.bundle);
      if (node.revision !== revision) return stale(nodeId, revision);
      this.#graph.replaceDependencies(nodeId, candidate.dependencies);

      // Runtime compatibility preparation is part of candidate validation, so it precedes the
      // durable pointer switch. commitFrame remains the only operation that exposes the payload.
      const staged = await node.publisher.stage({ revision, bundle: candidate.bundle });
      if (staged.status === 'stale') return stale(nodeId, revision);
      if (staged.status === 'failed') {
        return failed(nodeId, revision, staged.diagnostic.message);
      }
      if (node.revision !== revision) return stale(nodeId, revision);

      const published = await this.#artifactPublisher.publish({
        transactionId: `${nodeId}@${revision}`,
        nodeId,
        artifactKey: decoded.package.envelope.packageId,
        inputHashes: candidate.inputHashes,
        toolchainVersion: candidate.toolchainVersion,
        outputs: bundleOutputs(candidate.bundle),
        isCurrent: () => node.revision === revision,
        validate: () => true
      });
      if (node.revision !== revision || published.status === 'obsolete') {
        return stale(nodeId, revision);
      }
      if (published.status !== 'published' && published.status !== 'reused')
        return failed(nodeId, revision, 'Cook artifact rejected.');
      this.#staged.set(nodeId, { publisher: node.publisher, revision });
      return Object.freeze({ nodeId, revision, status: 'staged' });
    } catch (cause) {
      if (node.revision !== revision) return stale(nodeId, revision);
      return failed(
        nodeId,
        revision,
        cause instanceof Error ? cause.message : 'Shader recook failed.'
      );
    }
  }
}

const UTF8 = new TextEncoder();

function bundleOutputs(
  bundle: Parameters<typeof decodeCookedShaderPackage>[0]
): readonly CookCandidateOutput[] {
  return [
    { name: 'manifest', bytes: UTF8.encode(bundle.manifest) },
    ...[...bundle.blobs]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, bytes]) => ({ name: `blob:${id}`, bytes: bytes.slice() }))
  ];
}

function stale(nodeId: CookNodeId, revision: number): ShaderRecookResult {
  return Object.freeze({ nodeId, revision, status: 'stale' });
}

function failed(nodeId: CookNodeId, revision: number, message: string): ShaderRecookResult {
  return Object.freeze({ nodeId, revision, status: 'failed', message });
}
