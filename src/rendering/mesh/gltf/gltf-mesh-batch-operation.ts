import { cookCanonicalMeshDocument } from '../../../assets/cooker';
import type { GltfImportedBundle } from '../../../assets/importers/gltf';
import type {
  AssetPipelineOperationRegistry,
  AssetPipelineOperation,
  MergedAssetRequestDemand
} from '../../../assets/request-scheduler';
import type { AssetId } from '../../../assets/types';
import type { MeshData } from '../../../geometry';
import type { JobType } from '../../../jobs';
import type { RHIDevice, RHISubmission, UploadPlanner } from '../../../rhi';
import type { PreparedAssetRegistry } from '../../world';
import { selectGltfMesh } from './gltf-mesh-operation-utils';
import { prepareMeshBatchBudgeted } from '../mesh-budgeted-prepare';
import { disposePreparedMesh } from '../mesh-prepare';
import { createMeshUploadCandidate } from '../mesh-upload-candidate';
import type { PreparedMeshVariantInput } from '../types';
import type { CanonicalMeshDocument } from '../../../assets/canonical/types';

/** Authorities and shared variant identity for every primitive of one static glTF mesh. */
export interface GltfMeshBatchPipelineOperationOptions {
  readonly uri: string;
  readonly decodeJob: JobType<Uint8Array, GltfImportedBundle>;
  readonly meshAssetId: AssetId;
  readonly variant: Omit<PreparedMeshVariantInput, 'assetId'>;
  readonly planner: UploadPlanner;
  readonly prepared: PreparedAssetRegistry;
  readonly submitUpload: (device: RHIDevice) => RHISubmission;
  /** Publishes the validated canonical CPU mesh at the scheduler's finalize commit boundary. */
  readonly publishCpuPayload?: (
    mesh: CanonicalMeshDocument,
    request: MergedAssetRequestDemand
  ) => void;
  /** Observes asynchronous cleanup failures after an unpublished submission; must not throw. */
  readonly onCleanupError: (error: unknown) => void;
}

interface FinalizedGltfMeshBatch {
  readonly canonicalMesh: CanonicalMeshDocument;
  readonly primitives: readonly MeshData[];
}

/**
 * Cooks and publishes all primitives of one glTF mesh as a single upload transaction.
 *
 * Primitive-index suffixes are deterministic fallback subasset IDs. An edit that reorders source
 * primitives can change those identities; author-provided stable remapping is a later Asset DB
 * responsibility. Materials and textures retain their separate residency authority.
 */
export function createGltfMeshBatchPipelineOperation(
  input: GltfMeshBatchPipelineOperationOptions
): AssetPipelineOperation {
  const options = Object.freeze({ ...input, variant: Object.freeze({ ...input.variant }) });
  if (!options.uri.trim() || !options.meshAssetId.trim()) {
    throw new Error('glTF mesh batch requires a non-empty URI and mesh asset ID.');
  }
  if (typeof options.submitUpload !== 'function' || typeof options.onCleanupError !== 'function') {
    throw new Error('glTF mesh batch requires submission and cleanup authorities.');
  }
  const finalizedBatches = new WeakSet<object>();

  return Object.freeze({
    uri: options.uri,
    decodeJob: options.decodeJob,
    finalize(decoded: unknown, request: MergedAssetRequestDemand) {
      const { bundle, mesh } = selectGltfMesh(
        decoded,
        request,
        options.meshAssetId,
        options.variant.payloadVersion
      );
      const cooked = cookCanonicalMeshDocument(mesh, { materials: bundle.materials });
      if (cooked.primitives.length === 0)
        throw new Error('glTF mesh has no primitives to publish.');
      const finalized = Object.freeze({
        canonicalMesh: mesh,
        primitives: Object.freeze(cooked.primitives.map((primitive) => primitive.meshData))
      });
      finalizedBatches.add(finalized);
      return finalized;
    },
    ...(options.publishCpuPayload === undefined
      ? {}
      : {
          publishCpuPayload(
            decoded: unknown,
            finalized: unknown,
            request: MergedAssetRequestDemand
          ) {
            if (
              typeof finalized !== 'object' ||
              finalized === null ||
              !finalizedBatches.has(finalized)
            ) {
              throw new Error('glTF CPU publication requires this operation’s finalized payload.');
            }
            const batch = finalized as FinalizedGltfMeshBatch;
            const { mesh } = selectGltfMesh(
              decoded,
              request,
              options.meshAssetId,
              options.variant.payloadVersion
            );
            if (batch.canonicalMesh !== mesh) {
              throw new Error('glTF finalized CPU payload no longer matches its decoded mesh.');
            }
            options.publishCpuPayload!(batch.canonicalMesh, request);
          }
        }),
    upload(finalized: unknown, device: RHIDevice) {
      if (typeof finalized !== 'object' || finalized === null || !finalizedBatches.has(finalized)) {
        throw new Error('glTF mesh batch upload requires this operation’s finalized payload.');
      }
      const meshes = (finalized as FinalizedGltfMeshBatch).primitives;
      const items = meshes.map((mesh, index) => ({
        mesh,
        variant: {
          ...options.variant,
          assetId: `${options.meshAssetId}:primitive:${index}`
        }
      }));
      const admission = prepareMeshBatchBudgeted(device, items, options.planner);
      if (admission.status === 'deferred') return admission;
      let submission: RHISubmission;
      try {
        submission = options.submitUpload(device);
        for (const reservation of admission.reservations) {
          options.planner.retireAfter(reservation, submission);
        }
      } catch (error) {
        for (const reservation of admission.reservations) options.planner.release(reservation);
        const cleanupErrors: unknown[] = [];
        for (const asset of admission.prepared) {
          try {
            disposePreparedMesh(asset.value);
          } catch (cleanupError) {
            cleanupErrors.push(cleanupError);
          }
        }
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [error, ...cleanupErrors],
            'glTF mesh batch submission cleanup failed.'
          );
        }
        throw error;
      }
      return createMeshUploadCandidate(
        admission.prepared,
        submission,
        options.prepared,
        options.onCleanupError
      );
    }
  });
}

/** Registers a batch operation against the exact request identity and payload revision. */
export function registerGltfMeshBatchPipelineOperation(
  registry: Pick<AssetPipelineOperationRegistry, 'register'>,
  request: MergedAssetRequestDemand,
  options: GltfMeshBatchPipelineOperationOptions
): void {
  if (
    request.assetId !== options.meshAssetId ||
    request.revision !== options.variant.payloadVersion
  ) {
    throw new Error('glTF mesh batch registration does not match the request identity/revision.');
  }
  registry.register(request, createGltfMeshBatchPipelineOperation(options));
}
