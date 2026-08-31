import {
  DirectionalLightExtraction,
  DirectionalLightSource,
  RenderWorld,
  World,
  buildPreparedDrawPhase,
  createDirectionalLightExtractorPlan,
  type PreparedDrawPacket,
  type RenderEntityId
} from '../../src';

export interface PreparedDrawPhaseWorkload {
  readonly packets: readonly PreparedDrawPacket[];
  readonly ownership: { transfers: number };
}

export interface BaselinePluginStructuralSummary {
  readonly extractedLights: number;
  readonly queuedPackets: number;
  readonly queueSkips: number;
  readonly firstLightEntity: number;
}

export interface PreparedDrawPhaseSummary {
  readonly count: number;
  readonly checksum: number;
  readonly ownershipTransfers: number;
}

/** Creates a deterministic opaque packet workload with deliberately incoherent input order. */
export function createPreparedDrawPhaseWorkload(count: number): PreparedDrawPhaseWorkload {
  const ownership = { transfers: 0 };
  const packets = Array.from({ length: count }, (_, index) =>
    Object.freeze({
      entity: (count - index) as RenderEntityId,
      phase: 'opaque' as const,
      pipelineKey: `pipeline:${index % 17}`,
      materialKey: `material:${index % 13}`,
      meshKey: `mesh:${index % 11}`,
      bindingKey: `binding:${index % 7}`,
      drawKey: `draw:${index % 5}`,
      distance: index,
      insertionOrder: index,
      pipeline: {} as never,
      bindingSet: {} as never,
      vertexBuffers: Object.freeze([]),
      indexBuffer: {} as never,
      indexFormat: 'uint16' as const,
      firstIndex: 0,
      indexCount: 3,
      released: false,
      retentionReady: true,
      retain: () => ownership.transfers++,
      release: () => ownership.transfers++
    })
  );
  return Object.freeze({ packets: Object.freeze(packets), ownership });
}

export function runPreparedDrawPhaseSubject(
  workload: PreparedDrawPhaseWorkload
): PreparedDrawPhaseSummary {
  const result = buildPreparedDrawPhase('benchmark', 'opaque', workload.packets);
  return Object.freeze({
    count: result.snapshot.packets.length,
    checksum: checksum(result.snapshot.packets),
    ownershipTransfers: workload.ownership.transfers
  });
}

/** Independent scalar ordering oracle for prepared opaque packets. */
export function runPreparedDrawPhaseReference(
  workload: PreparedDrawPhaseWorkload
): PreparedDrawPhaseSummary {
  const packets = [...workload.packets].sort(
    (left, right) =>
      compare(left.pipelineKey, right.pipelineKey) ||
      compare(left.materialKey, right.materialKey) ||
      compare(left.meshKey, right.meshKey) ||
      compare(left.drawKey, right.drawKey) ||
      left.entity - right.entity ||
      left.insertionOrder - right.insertionOrder
  );
  return Object.freeze({
    count: packets.length,
    checksum: checksum(packets),
    ownershipTransfers: workload.ownership.transfers
  });
}

/** Exercises the baseline light-publication and prepared opaque Queue structural boundaries. */
export function runBaselinePluginStructuralSubject(count: number): BaselinePluginStructuralSummary {
  const main = new World().registerComponent(DirectionalLightSource);
  const render = new RenderWorld({ extractorPlan: createDirectionalLightExtractorPlan() });
  for (let index = 0; index < count; index += 1) {
    main
      .spawn()
      .insert(DirectionalLightSource, {
        direction: [0, -1, 0],
        colorLinear: [1, 1, 1],
        illuminanceLux: 10_000,
        enabled: true,
        layerMask: 1,
        castsShadow: false
      })
      .build();
  }
  const extraction = new DirectionalLightExtraction(main, render);
  const revision = extraction.extract({ sourceTick: 1 });
  const lights = extraction.lights();
  const workload = createPreparedDrawPhaseWorkload(count);
  const packets = workload.packets.map((packet, index) =>
    index % 5 === 0 ? Object.freeze({ ...packet, retentionReady: false }) : packet
  );
  const phase = buildPreparedDrawPhase('benchmark', 'opaque', packets);
  const summary = Object.freeze({
    extractedLights: lights.length,
    queuedPackets: phase.snapshot.packets.length,
    queueSkips: phase.skipped.length,
    firstLightEntity: lights[0]?.entity ?? -1
  });
  revision.release();
  extraction.dispose();
  return summary;
}

/** Independent structural oracle for the deterministic baseline workload. */
export function runBaselinePluginStructuralReference(
  count: number
): BaselinePluginStructuralSummary {
  const queueSkips = count === 0 ? 0 : Math.floor((count - 1) / 5) + 1;
  return Object.freeze({
    extractedLights: count,
    queuedPackets: count - queueSkips,
    queueSkips,
    firstLightEntity: count === 0 ? -1 : 1
  });
}

function checksum(packets: readonly PreparedDrawPacket[]): number {
  return packets.reduce((sum, packet, index) => sum + packet.entity * (index + 1), 0);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
