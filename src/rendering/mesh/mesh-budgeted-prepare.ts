import type { MeshData } from '../../geometry';
import type { RHIDevice } from '../../rhi';
import { type DeferredUploadReservation, type UploadReservation, UploadPlanner } from '../../rhi';
import type { PreparedAsset } from '../world';
import { disposePreparedMesh, prepareMesh } from './mesh-prepare';
import type { PreparedMesh, PreparedMeshVariantInput } from './types';

/** A complete mesh upload whose ranges must be retained until its submission is terminal. */
export interface BudgetedPreparedMesh {
  readonly status: 'prepared';
  readonly prepared: PreparedAsset<PreparedMesh>;
  readonly reservations: readonly UploadReservation[];
}

/** One validated primitive and its stable prepared-variant identity. */
export interface MeshBatchPreparationItem {
  readonly mesh: MeshData;
  readonly variant: PreparedMeshVariantInput;
}

/** An all-or-none prepared mesh batch whose ranges share one submission lifetime. */
export interface BudgetedPreparedMeshBatch {
  readonly status: 'prepared';
  readonly prepared: readonly PreparedAsset<PreparedMesh>[];
  readonly reservations: readonly UploadReservation[];
}

/**
 * Admits every mesh buffer write before creating any physical buffer.
 *
 * A deferred result has no GPU side effects. The caller owns successful reservations and must
 * attach them to the actual submission with `UploadPlanner.retireAfter`, or release them if the
 * prepared variant is abandoned before submission.
 */
export function prepareMeshBudgeted(
  device: RHIDevice,
  mesh: MeshData,
  variant: PreparedMeshVariantInput,
  planner: UploadPlanner
): BudgetedPreparedMesh | DeferredUploadReservation {
  const reservations: UploadReservation[] = [];
  const byteLengths = mesh.streams.map((stream) => stream.data.byteLength);
  if (mesh.indices !== undefined) byteLengths.push(mesh.indices.data.byteLength);

  try {
    for (const byteLength of byteLengths) {
      const admission = planner.reserve(byteLength);
      if (admission.status === 'deferred') {
        for (const reservation of reservations) planner.release(reservation);
        return admission;
      }
      reservations.push(admission);
    }
    const prepared = prepareMesh(device, mesh, variant);
    return Object.freeze({
      status: 'prepared' as const,
      prepared,
      reservations: Object.freeze(reservations)
    });
  } catch (error) {
    for (const reservation of reservations) planner.release(reservation);
    throw error;
  }
}

/**
 * Admits every write of every primitive before creating the first physical buffer.
 *
 * A deferred result has no GPU side effects. The caller owns all successful reservations until
 * they are bound to the real submission; backend failure disposes every earlier primitive.
 */
export function prepareMeshBatchBudgeted(
  device: RHIDevice,
  items: readonly MeshBatchPreparationItem[],
  planner: UploadPlanner
): BudgetedPreparedMeshBatch | DeferredUploadReservation {
  if (items.length === 0) throw new Error('Mesh preparation batch must not be empty.');
  const reservations: UploadReservation[] = [];
  const prepared: PreparedAsset<PreparedMesh>[] = [];
  try {
    for (const item of items) {
      const deferral = reserveMeshRanges(item.mesh, planner, reservations);
      if (deferral !== undefined) {
        for (const reservation of reservations) planner.release(reservation);
        return deferral;
      }
    }
    for (const item of items) prepared.push(prepareMesh(device, item.mesh, item.variant));
    return Object.freeze({
      status: 'prepared' as const,
      prepared: Object.freeze(prepared),
      reservations: Object.freeze(reservations)
    });
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    for (const entry of prepared.reverse()) {
      try {
        disposePreparedMesh(entry.value);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    for (const reservation of reservations) planner.release(reservation);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        'Mesh batch preparation and cleanup failed.'
      );
    }
    throw error;
  }
}

function reserveMeshRanges(
  mesh: MeshData,
  planner: UploadPlanner,
  reservations: UploadReservation[]
): DeferredUploadReservation | undefined {
  for (const stream of mesh.streams) {
    const admission = planner.reserve(stream.data.byteLength);
    if (admission.status === 'deferred') return admission;
    reservations.push(admission);
  }
  if (mesh.indices !== undefined) {
    const admission = planner.reserve(mesh.indices.data.byteLength);
    if (admission.status === 'deferred') return admission;
    reservations.push(admission);
  }
  return undefined;
}
