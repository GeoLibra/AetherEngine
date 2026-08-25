import type { RenderPhaseKind } from './render-phase';
import type {
  PreparedDrawPacket,
  PreparedDrawPhaseResult,
  PreparedDrawPhaseSkip,
  PreparedDrawPhaseSkipCode
} from './types';

/**
 * Selects and canonically orders prepared draw packets for one view phase.
 *
 * Packet identity and ownership are preserved. This function never retains, releases, or copies
 * packet-owned RHI resources.
 *
 * @throws When `viewId` is not a non-empty string.
 */
export function buildPreparedDrawPhase(
  viewId: string,
  phase: RenderPhaseKind,
  input: readonly PreparedDrawPacket[]
): PreparedDrawPhaseResult {
  if (typeof viewId !== 'string' || !viewId.trim())
    throw new Error('Prepared draw phase view ID must be non-empty.');

  const packets: PreparedDrawPacket[] = [];
  const skipped: PreparedDrawPhaseSkip[] = [];
  const associations = new Set<string>();
  for (const packet of input) {
    if (packet.phase !== phase) {
      skipped.push(
        skip(
          packet,
          'draw-phase-mismatch',
          `Draw packet phase "${packet.phase}" does not match "${phase}".`
        )
      );
      continue;
    }
    if (packet.released) {
      skipped.push(skip(packet, 'released-draw-packet', 'Prepared draw packet has been released.'));
      continue;
    }
    const association = `${packet.entity}:${packet.insertionOrder}`;
    if (associations.has(association)) {
      skipped.push(
        skip(packet, 'duplicate-draw-association', 'Prepared draw queue association is duplicated.')
      );
      continue;
    }
    associations.add(association);
    packets.push(packet);
  }
  packets.sort(packetComparator(phase));
  return Object.freeze({
    snapshot: Object.freeze({ viewId, phase, packets: Object.freeze(packets) }),
    skipped: Object.freeze(skipped)
  });
}

function packetComparator(
  phase: RenderPhaseKind
): (left: PreparedDrawPacket, right: PreparedDrawPacket) => number {
  return (left, right) => {
    if (phase === 'transparent')
      return (
        right.distance - left.distance ||
        left.entity - right.entity ||
        left.insertionOrder - right.insertionOrder
      );
    if (phase === 'overlay')
      return left.insertionOrder - right.insertionOrder || left.entity - right.entity;
    return (
      compareCodeUnits(left.pipelineKey, right.pipelineKey) ||
      compareCodeUnits(left.materialKey, right.materialKey) ||
      compareCodeUnits(left.meshKey, right.meshKey) ||
      compareCodeUnits(left.drawKey, right.drawKey) ||
      left.entity - right.entity ||
      left.insertionOrder - right.insertionOrder
    );
  };
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function skip(
  packet: PreparedDrawPacket,
  code: PreparedDrawPhaseSkipCode,
  message: string
): PreparedDrawPhaseSkip {
  return Object.freeze({
    entity: packet.entity,
    reason: 'incompatible-prepared-draw-phase',
    code,
    message
  });
}
