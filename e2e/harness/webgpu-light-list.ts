import {
  RenderGraphBuilder,
  RenderGraphExecutor,
  ZERO_RESOURCE_BUDGET,
  buildCpuLightLists,
  compileRenderGraph,
  createRenderGraphExecutionPlan,
  createWebGpuComputeLightListImplementation,
  decodeWebGpuLightListOutput,
  packWebGpuLightListInput,
  prepareWebGpuLightListRecorder,
  type BrowserGraphicsSession,
  type BufferHandle,
  type RenderEntityId,
  type RestrictedPassContext,
  type LightReceiver,
  type PreparedLight,
  type WebGpuLightListBuildOutput
} from '../../src';

const STORAGE = 1 << 7;
const COPY_SRC = 1 << 2;
const COPY_DST = 1 << 3;
const MAP_READ = 1;
const capacity = Object.freeze({
  maxDirectionalLights: 1,
  maxLightsPerReceiver: 2,
  maxLightIndices: 3
});

export interface WebGpuLightListGolden {
  readonly matchesCpuOracle: boolean;
  readonly directionalIndices: readonly number[];
  readonly headerCount: number;
  readonly lightIndexCount: number;
  readonly overflowed: boolean;
  readonly zeroLights: boolean;
  readonly zeroReceivers: boolean;
}

/** Executes the built-in kernel through RenderGraph and compares mapped GPU output with the CPU oracle. */
export async function runWebGpuLightListGolden(
  session: BrowserGraphicsSession
): Promise<WebGpuLightListGolden> {
  const main = await runCase(session, createFixture());
  const zeroLights = await runCase(session, { ...createFixture(), lights: [] });
  const zeroReceivers = await runCase(session, { ...createFixture(), receivers: [] });
  return Object.freeze({
    matchesCpuOracle: true,
    directionalIndices: main.directionalIndices,
    headerCount: main.headers.length,
    lightIndexCount: main.lightIndices.length,
    overflowed: main.overflowed,
    zeroLights:
      zeroLights.directionalIndices.length === 0 &&
      zeroLights.lightIndices.length === 0 &&
      zeroLights.headers.every((header) => header.count === 0),
    zeroReceivers: zeroReceivers.headers.length === 0 && zeroReceivers.lightIndices.length === 0
  });
}

interface LightListFixture {
  readonly viewLayerMask: number;
  readonly lights: readonly PreparedLight[];
  readonly receivers: readonly LightReceiver[];
}

async function runCase(session: BrowserGraphicsSession, fixture: LightListFixture) {
  const cpu = buildCpuLightLists({ ...fixture, capacity });
  const packed = packWebGpuLightListInput({ ...fixture, capacity });
  const device = session.device;
  const prepared = prepareWebGpuLightListRecorder(device);
  const inputs = [
    device.createBuffer({ size: packed.lights.byteLength, usage: STORAGE | COPY_DST }),
    device.createBuffer({ size: packed.receivers.byteLength, usage: STORAGE | COPY_DST })
  ] as const;
  device.queue.writeBuffer(inputs[0], 0, packed.lights);
  device.queue.writeBuffer(inputs[1], 0, packed.receivers);
  const readbacks = [
    device.createBuffer({ size: 4, usage: COPY_DST | MAP_READ }),
    device.createBuffer({
      size: Math.max(16, fixture.receivers.length * 16),
      usage: COPY_DST | MAP_READ
    }),
    device.createBuffer({ size: capacity.maxLightIndices * 4, usage: COPY_DST | MAP_READ }),
    device.createBuffer({ size: 16, usage: COPY_DST | MAP_READ })
  ] as const;

  try {
    const graph = new RenderGraphBuilder();
    const lightHandle = importedBuffer(graph, packed.lights.byteLength, 'lights', 'storage-read');
    const receiverHandle = importedBuffer(
      graph,
      packed.receivers.byteLength,
      'receivers',
      'storage-read'
    );
    let output: WebGpuLightListBuildOutput | undefined;
    const implementation = createWebGpuComputeLightListImplementation({
      capacity,
      estimatedBudget: ZERO_RESOURCE_BUDGET
    });
    const implementationPrepared = await implementation.prepare({
      capabilities: device.capabilities,
      hostServices: new Set(),
      profileId: 'e2e',
      deviceGeneration: device.generation,
      budget: ZERO_RESOURCE_BUDGET
    });
    implementation.contribute(implementationPrepared, {
      graph,
      viewId: 'e2e-light-list',
      input: {
        lights: lightHandle,
        receivers: receiverHandle,
        receiverCount: fixture.receivers.length
      },
      recorder: prepared.recorder,
      publish(value) {
        output = value;
      }
    });
    if (output === undefined) throw new Error('WebGPU LightList did not publish graph outputs.');
    const readbackHandles = readbacks.map((buffer, index) =>
      importedBuffer(graph, buffer.size, `readback-${index}`, 'copy-dst')
    );
    addReadbackPass(graph, output, readbackHandles);
    const snapshot = graph.build();
    const execution = new RenderGraphExecutor().execute(
      createRenderGraphExecutionPlan(snapshot, compileRenderGraph(snapshot)),
      {
        device,
        resources: new Map([
          [lightHandle, inputs[0]],
          [receiverHandle, inputs[1]],
          ...readbackHandles.map((handle, index) => [handle, readbacks[index]!] as const)
        ]),
        preparedComputePipelines: new Map([[prepared.pipelineToken, prepared.pipeline]]),
        preparedBindGroupLayouts: new Map([
          [prepared.bindGroupLayoutToken, prepared.bindGroupLayout]
        ])
      }
    );
    const completion = await execution.submission.done;
    if (completion.status !== 'completed')
      throw new Error(`WebGPU LightList submission ended with ${completion.status}.`);
    const words = await Promise.all(readbacks.map(readWords));
    const decoded = decodeWebGpuLightListOutput({
      directionalIndices: words[0]!,
      headers: words[1]!,
      lightIndices: words[2]!,
      overflow: words[3]!
    });
    const expectedHeaders = cpu.headers.map(({ receiver, offset, count, overflowed }) => ({
      receiver,
      offset,
      count,
      overflowed
    }));
    const matchesCpuOracle =
      JSON.stringify(decoded.directionalIndices) ===
        JSON.stringify(cpu.globalDirectionalLightIndices) &&
      JSON.stringify(decoded.headers) === JSON.stringify(expectedHeaders) &&
      JSON.stringify(decoded.lightIndices) === JSON.stringify(cpu.lightIndices) &&
      decoded.overflowed === cpu.overflowed;
    if (!matchesCpuOracle)
      throw new Error(
        `WebGPU LightList mismatch: ${JSON.stringify({ expected: cpu, actual: decoded })}`
      );
    return decoded;
  } finally {
    prepared.dispose();
    for (const buffer of [...inputs, ...readbacks]) buffer.dispose();
  }
}

function importedBuffer(
  graph: RenderGraphBuilder,
  size: number,
  id: string,
  initialState: 'storage-read' | 'copy-dst'
): BufferHandle {
  return graph.createBuffer(
    { size, usage: [initialState] },
    { origin: { kind: 'imported', initialState, acquire: { kind: 'external-acquire', id } } }
  );
}

function addReadbackPass(
  graph: RenderGraphBuilder,
  output: WebGpuLightListBuildOutput,
  destinations: readonly BufferHandle[]
): void {
  const sources = [output.directionalIndices, output.headers, output.lightIndices, output.overflow];
  graph.addPass({
    id: 'light-list:webgpu-readback',
    setup(pass) {
      pass.sideEffect('copy LightList outputs to readback buffers');
      return sources.map((source, index) => ({
        source: pass.readBuffer(source, 'copy-src'),
        destination: pass.writeBuffer(destinations[index]!, 'copy-dst')
      }));
    },
    run(context: RestrictedPassContext, copies) {
      for (const copy of copies)
        context.copyBufferToBuffer(
          context.buffer(copy.source, 'copy-src'),
          context.buffer(copy.destination, 'copy-dst')
        );
    }
  });
}

async function readWords(buffer: ReturnType<BrowserGraphicsSession['device']['createBuffer']>) {
  await buffer.mapAsync(MAP_READ);
  const words = new Uint32Array(buffer.getMappedRange().slice(0));
  buffer.unmap();
  return words;
}

function createFixture() {
  const entity = (value: number) => value as RenderEntityId;
  return {
    viewLayerMask: 1,
    lights: [
      {
        entity: entity(1),
        payloadVersion: 1,
        kind: 'directional' as const,
        direction: [0, -1, 0] as const,
        illuminanceLux: 10,
        colorLinear: [1, 1, 1] as const,
        enabled: true,
        layerMask: 1,
        castsShadow: false
      },
      {
        entity: entity(2),
        payloadVersion: 1,
        kind: 'directional' as const,
        direction: [1, -1, 0] as const,
        illuminanceLux: 5,
        colorLinear: [1, 1, 1] as const,
        enabled: true,
        layerMask: 1,
        castsShadow: false
      },
      ...[3, 4, 5].map((value) => ({
        entity: entity(value),
        payloadVersion: 1,
        kind: 'point' as const,
        position: [0, 0, 0] as const,
        luminousIntensityCandela: 1,
        range: 5,
        colorLinear: [1, 1, 1] as const,
        enabled: true,
        layerMask: 1,
        castsShadow: false
      }))
    ],
    receivers: [
      {
        renderEntity: entity(10),
        layerMask: 1,
        bounds: { kind: 'sphere' as const, center: [0, 0, 0] as const, radius: 1 }
      },
      {
        renderEntity: entity(11),
        layerMask: 1,
        bounds: { kind: 'aabb' as const, min: [-1, -1, -1] as const, max: [1, 1, 1] as const }
      }
    ]
  };
}
