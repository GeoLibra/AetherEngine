import type { RHISubmission } from '../rhi/contracts';
import type {
  PrepareDrawPacketInput,
  PreparedDrawPacket,
  PreparedDrawPacketResult,
  PreparedDrawPacketSkipCode
} from './types';

/**
 * Joins already prepared pipeline, binding, and mesh facts without creating RHI resources.
 *
 * @returns A submission-retainable indexed draw packet or a typed compatibility skip.
 */
export function prepareDrawPacket(input: PrepareDrawPacketInput): PreparedDrawPacketResult {
  const { availability, binding, candidate } = input;
  if (
    availability.pipelineLease.pipeline !== availability.pipeline ||
    binding.lease.bindingSet !== binding.bindingSet
  )
    throw new Error('Prepared draw cache lease does not match its published resource.');
  if (candidate.entity !== availability.bound.item.entity)
    return skipped(input, 'draw-entity-mismatch', 'Draw candidate entity does not match Queue.');
  if (
    binding.bindingSet.bindingKey.canonicalValue !== availability.bound.bindingKey.canonicalValue ||
    binding.bindingSet.bindingKey.hash !== availability.bound.bindingKey.hash
  )
    return skipped(
      input,
      'binding-key-mismatch',
      'Realized bind groups do not match the bound Material identity.'
    );
  const mesh = candidate.mesh.prepared.value;
  const deviceGeneration = availability.pipelineLease.deviceGeneration;
  if (
    availability.pipeline.generation !== deviceGeneration ||
    binding.bindingSet.deviceGeneration !== deviceGeneration ||
    mesh.deviceGeneration !== deviceGeneration ||
    candidate.material.prepared.value.deviceGeneration !== deviceGeneration
  )
    return skipped(
      input,
      'device-generation-stale',
      'Prepared draw resources belong to different device generations.'
    );
  if (
    availability.pipelineLease.released ||
    binding.lease.released ||
    candidate.mesh.disposed ||
    candidate.material.disposed
  )
    return skipped(input, 'draw-lease-released', 'Prepared draw ownership has been released.');
  if (mesh.indexBuffer === undefined || mesh.layout.indexFormat === undefined)
    return skipped(
      input,
      'indexed-draw-required',
      'Baseline draw packets require indexed mesh data.'
    );
  const submesh = mesh.submeshes[candidate.submesh];
  if (
    submesh === undefined ||
    !Number.isSafeInteger(submesh.start) ||
    submesh.start < 0 ||
    !Number.isSafeInteger(submesh.count) ||
    submesh.count < 1
  )
    return skipped(input, 'invalid-draw-range', 'Prepared draw submesh range is invalid.');

  let released = false;
  const packet: PreparedDrawPacket = Object.freeze({
    entity: candidate.entity,
    phase: availability.bound.item.phase,
    pipelineKey: availability.bound.item.pipelineKey,
    materialKey: availability.bound.item.materialKey,
    meshKey: availability.bound.item.meshKey,
    bindingKey: availability.bound.item.bindingKey,
    drawKey: availability.bound.item.drawKey,
    distance: availability.bound.item.distance,
    insertionOrder: availability.bound.item.insertionOrder,
    pipeline: availability.pipeline,
    bindingSet: binding.bindingSet,
    vertexBuffers: mesh.vertexBuffers,
    indexBuffer: mesh.indexBuffer,
    indexFormat: mesh.layout.indexFormat,
    firstIndex: submesh.start,
    indexCount: submesh.count,
    get released() {
      return released;
    },
    retain(submission: RHISubmission) {
      if (released) throw new Error('Prepared draw packet has already been released.');
      if (candidate.mesh.disposed || candidate.material.disposed)
        throw new Error('Prepared draw packet borrowed asset lease has already been released.');
      availability.pipelineLease.retain(submission);
      binding.lease.retain(submission);
      candidate.mesh.retainUntil(submission);
      candidate.material.retainUntil(submission);
    },
    release() {
      if (released) return;
      released = true;
      availability.pipelineLease.release();
      binding.lease.release();
    }
  });
  return Object.freeze({ status: 'ready', packet });
}

function skipped(
  input: PrepareDrawPacketInput,
  code: PreparedDrawPacketSkipCode,
  message: string
): PreparedDrawPacketResult {
  return Object.freeze({
    status: 'skipped',
    entity: input.availability.bound.item.entity,
    reason: 'incompatible-draw-packet',
    code,
    message
  });
}
