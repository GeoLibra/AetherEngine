import type { RHIBuffer, RHIQueue, RHIUploadData } from '../contracts';
import type { DeferredUploadReservation, UploadReservation } from './upload-planner';
import { UploadPlanner } from './upload-planner';

/** Result of one queue write guarded by a staging-ring and frame-budget reservation. */
export type BudgetedBufferWriteResult =
  Readonly<{ status: 'written'; reservation: UploadReservation }> | DeferredUploadReservation;

/**
 * Admits a CPU buffer upload before calling the backend queue.
 *
 * Backend queues remain responsible for validating the destination and consuming the input. If
 * their write rejects, the local planner reservation is released so its telemetry never presents
 * that failed write as accepted work.
 */
export function executeBudgetedBufferWrite(
  planner: UploadPlanner,
  queue: RHIQueue,
  buffer: RHIBuffer,
  offset: number,
  data: RHIUploadData
): BudgetedBufferWriteResult {
  const byteLength = uploadByteLength(data);
  const reservation = planner.reserve(byteLength);
  if (reservation.status === 'deferred') return reservation;
  try {
    queue.writeBuffer(buffer, offset, data);
  } catch (error) {
    planner.release(reservation);
    throw error;
  }
  return Object.freeze({ status: 'written', reservation });
}

function uploadByteLength(data: RHIUploadData): number {
  return data instanceof ArrayBuffer ? data.byteLength : data.byteLength;
}
