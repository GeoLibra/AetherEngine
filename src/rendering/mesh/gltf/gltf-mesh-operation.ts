import type { AssetId } from '../../../assets/types';
import type { CanonicalMeshDocument } from '../../../assets/canonical/types';
import { cookCanonicalMeshDocument } from '../../../assets/cooker';
import type { GltfImportedBundle } from '../../../assets/importers/gltf';
import type {
  AssetPipelineOperation,
  MergedAssetRequestDemand
} from '../../../assets/request-scheduler';
import type { JobType } from '../../../jobs';
import type { MeshData } from '../../../geometry';
import type { RHIDevice, RHISubmission, UploadPlanner } from '../../../rhi';
import type { PreparedAssetRegistry } from '../../world';
import { prepareMeshBudgeted } from '../mesh-budgeted-prepare';
import { selectGltfMesh } from './gltf-mesh-operation-utils';
import { createMeshUploadCandidate } from '../mesh-upload-candidate';
import { disposePreparedMesh } from '../mesh-prepare';
import type { PreparedMeshVariantInput } from '../types';

/** Authorities required to load and publish one static glTF mesh primitive. */
export interface GltfMeshPipelineOperationOptions {
  readonly uri: string;
  /** Registered decode job that imports source bytes into a canonical glTF bundle. */
  readonly decodeJob: JobType<Uint8Array, GltfImportedBundle>;
  readonly meshAssetId: AssetId;
  readonly primitiveIndex: number;
  readonly variant: PreparedMeshVariantInput;
  readonly planner: UploadPlanner;
  readonly prepared: PreparedAssetRegistry;
  /** Submits the preceding queue writes and returns their real terminal epoch. */
  readonly submitUpload: (device: RHIDevice) => RHISubmission;
  /** Publishes the validated canonical CPU mesh at the scheduler's finalize commit boundary. */
  readonly publishCpuPayload?: (
    mesh: CanonicalMeshDocument,
    request: MergedAssetRequestDemand
  ) => void;
  /** Observes asynchronous cleanup failures after an unpublished submission terminates; must not throw. */
  readonly onCleanupError: (error: unknown) => void;
}

/**
 * Binds glTF import/cook to budgeted mesh preparation and transactional variant publication.
 *
 * One operation selects exactly one primitive. Materials and textures remain separate assets.
 * The caller must register `decodeJob` with the injected JobScheduler before execution.
 */
export function createGltfMeshPipelineOperation(
  input: GltfMeshPipelineOperationOptions
): AssetPipelineOperation {
  const options = Object.freeze({ ...input, variant: Object.freeze({ ...input.variant }) });
  if (!options.uri.trim()) throw new Error('glTF mesh operation URI must be non-empty.');
  if (!options.meshAssetId.trim()) throw new Error('glTF mesh asset ID must be non-empty.');
  if (typeof options.submitUpload !== 'function' || typeof options.onCleanupError !== 'function') {
    throw new Error('glTF mesh operation requires submission and cleanup authorities.');
  }
  if (!Number.isSafeInteger(options.primitiveIndex) || options.primitiveIndex < 0) {
    throw new Error('glTF mesh primitive index must be a non-negative safe integer.');
  }
  if (options.variant.assetId !== options.meshAssetId) {
    throw new Error('glTF mesh variant asset ID must match the selected mesh asset ID.');
  }
  const finalizedMeshes = new WeakMap<MeshData, CanonicalMeshDocument>();

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
      const primitive = cookCanonicalMeshDocument(mesh, { materials: bundle.materials }).primitives[
        options.primitiveIndex
      ];
      if (primitive === undefined) {
        throw new Error(`glTF mesh primitive ${options.primitiveIndex} is absent.`);
      }
      finalizedMeshes.set(primitive.meshData, mesh);
      return primitive.meshData;
    },
    ...(options.publishCpuPayload === undefined
      ? {}
      : {
          publishCpuPayload(
            decoded: unknown,
            finalized: unknown,
            request: MergedAssetRequestDemand
          ) {
            if (typeof finalized !== 'object' || finalized === null) {
              throw new Error('glTF CPU publication requires this operation’s finalized mesh.');
            }
            const canonicalMesh = finalizedMeshes.get(finalized as MeshData);
            if (canonicalMesh === undefined) {
              throw new Error('glTF CPU publication requires this operation’s finalized mesh.');
            }
            const selected = selectGltfMesh(
              decoded,
              request,
              options.meshAssetId,
              options.variant.payloadVersion
            );
            if (selected.mesh !== canonicalMesh) {
              throw new Error('glTF finalized CPU payload no longer matches its decoded mesh.');
            }
            options.publishCpuPayload!(canonicalMesh, request);
          }
        }),
    upload(finalized: unknown, device: RHIDevice) {
      if (
        typeof finalized !== 'object' ||
        finalized === null ||
        !finalizedMeshes.has(finalized as MeshData)
      ) {
        throw new Error('glTF mesh upload requires this operation’s finalized mesh payload.');
      }
      const admission = prepareMeshBudgeted(
        device,
        finalized as MeshData,
        options.variant,
        options.planner
      );
      if (admission.status === 'deferred') return admission;
      let submission: RHISubmission;
      try {
        submission = options.submitUpload(device);
        for (const reservation of admission.reservations) {
          options.planner.retireAfter(reservation, submission);
        }
      } catch (error) {
        for (const reservation of admission.reservations) options.planner.release(reservation);
        disposePreparedMesh(admission.prepared.value);
        throw error;
      }

      return createMeshUploadCandidate(
        [admission.prepared],
        submission,
        options.prepared,
        options.onCleanupError
      );
    }
  });
}
