import {
  RenderGraphExecutor,
  RenderSystemRegistry,
  compileRenderSystems,
  createOpaqueRenderSystem,
  type PreparedDrawPacket,
  type RHISurface,
  type RenderEntityId,
  type RenderView,
  type SurfaceFrameToken,
  type TextureDescriptor
} from '../../src';
import type {
  RHIBindGroup,
  RHIBuffer,
  RHIDevice,
  RHIRenderPipeline,
  RHISubmission
} from '../../src/rhi/contracts';

export const E2E_OPAQUE_RENDER_PATH = 'opaque-render-system' as const;

export interface E2EDrawPacketInput {
  readonly entity: RenderEntityId;
  readonly drawKey: string;
  readonly pipeline: RHIRenderPipeline;
  readonly bindGroups?: readonly RHIBindGroup[];
  readonly dynamicOffsetsByGroup?: readonly (readonly number[])[];
  readonly vertexBuffers?: readonly RHIBuffer[];
  readonly indexBuffer: RHIBuffer;
  readonly indexFormat: 'uint16' | 'uint32';
  readonly firstIndex?: number;
  readonly indexCount: number;
  readonly retain: (submission: RHISubmission) => void;
  readonly release: () => void;
}

export interface ExecuteOpaqueSceneInput {
  readonly device: RHIDevice;
  readonly surface: RHISurface;
  readonly view: RenderView;
  readonly surfaceFrame: SurfaceFrameToken;
  readonly width: number;
  readonly height: number;
  readonly colorFormat: TextureDescriptor['format'];
  readonly packets: readonly PreparedDrawPacket[];
}

/**
 * Creates an immutable browser-fixture packet at the production prepared-draw boundary.
 *
 * Browser scenes own the actual RHI resources and provide their retention callbacks. This helper
 * only supplies deterministic Queue identity and lifecycle state; it never creates GPU resources.
 */
export function createE2EDrawPacket(input: E2EDrawPacketInput): PreparedDrawPacket {
  let released = false;
  const bindGroups = Object.freeze([...(input.bindGroups ?? [])]);
  const dynamicOffsetsByGroup = Object.freeze(
    (input.dynamicOffsetsByGroup ?? bindGroups.map(() => [])).map((offsets) =>
      Object.freeze([...offsets])
    )
  );
  if (dynamicOffsetsByGroup.length !== bindGroups.length) {
    throw new Error('E2E draw packet bind groups and dynamic-offset groups must match.');
  }

  return Object.freeze({
    entity: input.entity,
    phase: 'opaque',
    pipelineKey: `pipeline:${input.drawKey}`,
    materialKey: `material:${input.drawKey}`,
    meshKey: `mesh:${input.drawKey}`,
    bindingKey: `binding:${input.drawKey}`,
    drawKey: input.drawKey,
    distance: 0,
    insertionOrder: 0,
    pipeline: input.pipeline,
    bindingSet: Object.freeze({
      bindingKey: Object.freeze({}) as never,
      bindGroups,
      dynamicOffsetsByGroup,
      deviceGeneration: input.pipeline.generation
    }),
    vertexBuffers: Object.freeze([...(input.vertexBuffers ?? [])]),
    indexBuffer: input.indexBuffer,
    indexFormat: input.indexFormat,
    firstIndex: input.firstIndex ?? 0,
    indexCount: input.indexCount,
    get released() {
      return released;
    },
    get retentionReady() {
      return !released;
    },
    retain(submission: RHISubmission) {
      if (released) throw new Error('E2E draw packet has already been released.');
      input.retain(submission);
    },
    release() {
      if (released) return;
      released = true;
      input.release();
    }
  });
}

/** Executes browser prepared draws exclusively through the public opaque RenderSystem facade. */
export function executeOpaqueScene(input: ExecuteOpaqueSceneInput) {
  const prepared = createOpaqueRenderSystem({
    phase: Object.freeze({
      viewId: input.view.id,
      phase: 'opaque',
      packets: Object.freeze([...input.packets])
    }),
    surfaceFrame: input.surfaceFrame,
    color: textureDescriptor(input.width, input.height, input.colorFormat, 'color-attachment'),
    depth: textureDescriptor(input.width, input.height, 'depth24plus', 'depth-stencil-attachment')
  });
  const registry = new RenderSystemRegistry();
  registry.add(prepared.descriptor);
  const compiled = compileRenderSystems(registry, { views: [input.view] });
  const execution = new RenderGraphExecutor().execute(compiled.plan, {
    device: input.device,
    surface: input.surface,
    preparedDrawResources: prepared.preparedDrawResources
  });

  return Object.freeze({
    renderPath: E2E_OPAQUE_RENDER_PATH,
    renderSystemInstances: Object.freeze(compiled.instances.map(({ id }) => id)),
    execution
  });
}

function textureDescriptor(
  width: number,
  height: number,
  format: TextureDescriptor['format'],
  usage: 'color-attachment' | 'depth-stencil-attachment'
) {
  return Object.freeze({
    width,
    height,
    depthOrArrayLayers: 1,
    mipLevelCount: 1,
    sampleCount: 1,
    format,
    usage: Object.freeze([usage])
  });
}
