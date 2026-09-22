import {
  RenderGraphBuilder,
  RenderGraphExecutor,
  buildClusterGrid,
  buildCpuClusters,
  compileRenderGraph,
  createRenderGraphExecutionPlan,
  contributeWebGpuClusterLightList,
  decodeWebGpuClusterLightListOutput,
  packClusterGridForWebGpu,
  packWebGpuClusterLights,
  prepareWebGpuClusterLightListRecorder,
  type BrowserGraphicsSession,
  type BufferHandle,
  type ClusterCapacity,
  type PreparedLight,
  type RenderEntityId,
  type WebGpuClusterLightListOutput
} from '../../src';

const STORAGE = 1 << 7;
const COPY_SRC = 1 << 2;
const COPY_DST = 1 << 3;
const MAP_READ = 1;
const capacity: ClusterCapacity = Object.freeze({
  maxDirectionalLights: 2,
  maxLightsPerCluster: 3,
  maxClusterIndices: 12
});

/** Evidence returned by a real WebGPU mapped-output comparison against the CPU cluster oracle. */
export interface WebGpuClusterLightListGolden {
  readonly matchesCpuOracle: boolean;
  readonly directionalIndices: readonly number[];
  readonly headerCount: number;
  readonly lightIndexCount: number;
  readonly overflowed: boolean;
}

/** Runs the reference cluster compute through RenderGraph and verifies every mapped output field. */
export async function runWebGpuClusterLightListGolden(
  session: BrowserGraphicsSession
): Promise<WebGpuClusterLightListGolden> {
  const fixture = createFixture();
  const cpu = buildCpuClusters({ ...fixture, capacity });
  const packedLights = packWebGpuClusterLights(fixture);
  const packedGrid = packClusterGridForWebGpu(fixture.grid, capacity);
  const device = session.device;
  const recorder = prepareWebGpuClusterLightListRecorder(device);
  const inputs = [
    device.createBuffer({ size: packedLights.words.byteLength, usage: STORAGE | COPY_DST }),
    device.createBuffer({ size: packedGrid.words.byteLength, usage: STORAGE | COPY_DST })
  ] as const;
  device.queue.writeBuffer(inputs[0], 0, packedLights.words);
  device.queue.writeBuffer(inputs[1], 0, packedGrid.words);
  const readbacks = [
    device.createBuffer({ size: capacity.maxDirectionalLights * 4, usage: COPY_DST | MAP_READ }),
    device.createBuffer({ size: fixture.grid.clusterCount * 16, usage: COPY_DST | MAP_READ }),
    device.createBuffer({ size: capacity.maxClusterIndices * 4, usage: COPY_DST | MAP_READ }),
    device.createBuffer({ size: 16, usage: COPY_DST | MAP_READ })
  ] as const;

  try {
    const graph = new RenderGraphBuilder();
    const lights = importedBuffer(
      graph,
      packedLights.words.byteLength,
      'cluster-lights',
      'storage-read'
    );
    const clusters = importedBuffer(
      graph,
      packedGrid.words.byteLength,
      'cluster-grid',
      'storage-read'
    );
    let output: WebGpuClusterLightListOutput | undefined;
    contributeWebGpuClusterLightList(
      graph,
      { lights, clusters },
      fixture.grid.clusterCount,
      capacity,
      recorder,
      (value) => {
        output = value;
      }
    );
    if (output === undefined)
      throw new Error('WebGPU cluster LightList did not publish graph outputs.');
    const destinations = readbacks.map((buffer, index) =>
      importedBuffer(graph, buffer.size, `cluster-readback-${index}`, 'copy-dst')
    );
    addReadbackPass(graph, output, destinations);
    const snapshot = graph.build();
    const execution = new RenderGraphExecutor().execute(
      createRenderGraphExecutionPlan(snapshot, compileRenderGraph(snapshot)),
      {
        device,
        resources: new Map([
          [lights, inputs[0]],
          [clusters, inputs[1]],
          ...destinations.map((handle, index) => [handle, readbacks[index]!] as const)
        ]),
        preparedComputePipelines: new Map([[recorder.pipelineToken, recorder.pipeline]]),
        preparedBindGroupLayouts: new Map([
          [recorder.bindGroupLayoutToken, recorder.bindGroupLayout]
        ])
      }
    );
    const completion = await execution.submission.done;
    if (completion.status !== 'completed') {
      throw new Error(`WebGPU cluster submission ended with ${completion.status}.`);
    }
    const words = await Promise.all(readbacks.map(readWords));
    const decoded = decodeWebGpuClusterLightListOutput({
      directionalIndices: words[0]!,
      headers: words[1]!,
      lightIndices: words[2]!,
      overflow: words[3]!
    });
    const expectedHeaders = cpu.headers.map(({ cluster, offset, count, overflowed }) => ({
      cluster,
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
    if (!matchesCpuOracle) {
      throw new Error(
        `WebGPU cluster LightList mismatch: ${JSON.stringify({ expected: cpu, actual: decoded })}`
      );
    }
    return Object.freeze({
      matchesCpuOracle,
      directionalIndices: decoded.directionalIndices,
      headerCount: decoded.headers.length,
      lightIndexCount: decoded.lightIndices.length,
      overflowed: decoded.overflowed
    });
  } finally {
    recorder.dispose();
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
  output: WebGpuClusterLightListOutput,
  destinations: readonly BufferHandle[]
): void {
  const sources = [output.directional, output.headers, output.indices, output.overflow];
  graph.addCopyPass({
    id: 'cluster-light-list:webgpu-readback',
    setup(pass) {
      pass.sideEffect('copy clustered LightList outputs to readback buffers');
      return sources.map((source, index) => ({
        source: pass.readBuffer(source, 'copy-src'),
        destination: pass.writeBuffer(destinations[index]!, 'copy-dst')
      }));
    },
    run(context, copies) {
      for (const copy of copies) {
        context.copy.copyBufferToBuffer(
          context.buffer(copy.source, 'copy-src'),
          context.buffer(copy.destination, 'copy-dst')
        );
      }
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
  const grid = buildClusterGrid({
    viewId: 'e2e-cluster',
    projectionRevision: 1,
    viewTransformRevision: 1,
    deviceGeneration: 1,
    viewport: { width: 32, height: 16 },
    cameraNear: 1,
    cameraFar: 9,
    slicing: { depth: 'finite', shape: 'uniform', lambda: 0 },
    sliceCount: 2,
    inverseViewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    tilesX: 2,
    tilesY: 1
  });
  const lights: readonly PreparedLight[] = [
    {
      entity: entity(1),
      payloadVersion: 1,
      kind: 'directional',
      direction: [0, -1, 0],
      illuminanceLux: 10,
      colorLinear: [1, 1, 1],
      enabled: true,
      layerMask: 1,
      castsShadow: false
    },
    {
      entity: entity(2),
      payloadVersion: 1,
      kind: 'point',
      position: [0, 0, 0],
      range: 4,
      luminousIntensityCandela: 2,
      colorLinear: [1, 0.5, 0.25],
      enabled: true,
      layerMask: 1,
      castsShadow: false
    },
    {
      entity: entity(3),
      payloadVersion: 1,
      kind: 'spot',
      position: [0, 0, 0],
      direction: [0, 0, 1],
      range: 6,
      innerRadians: 0.2,
      outerRadians: 0.5,
      luminousIntensityCandela: 3,
      colorLinear: [0.25, 0.5, 1],
      enabled: true,
      layerMask: 1,
      castsShadow: false
    }
  ];
  return Object.freeze({ viewId: grid.viewId, viewLayerMask: 1, grid, lights });
}
