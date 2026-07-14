import type { GPUBindingResource, RHIBindGroup } from '../resource-types';
import { WebGL2RenderPipeline } from './pipeline';
import { getWebGL2Handle } from './resource';
import type { WebGL2DeviceOwner } from './resource-types';
import type { WebGL2ImageCopyTexture, WebGL2ReplayCommand } from './command-types';
import type { WebGL2Metrics } from './metrics';
import type { WebGL2NativeContextPort } from './native-types';
import { WebGL2StateVM } from './state';

interface BoundGroup {
  readonly group: RHIBindGroup;
  readonly dynamicOffsets: readonly number[];
}

export class WebGL2ReplayExecutor {
  readonly state: WebGL2StateVM;
  private pipeline: WebGL2RenderPipeline | undefined;
  private readonly groups = new Map<number, BoundGroup>();

  constructor(
    private readonly owner: WebGL2DeviceOwner,
    private readonly native: WebGL2NativeContextPort,
    private readonly metrics: WebGL2Metrics
  ) { this.state = new WebGL2StateVM(native, metrics); }

  execute(commands: readonly WebGL2ReplayCommand[]): void {
    for (const command of commands) this.executeCommand(command);
  }

  private executeCommand(command: WebGL2ReplayCommand): void {
    switch (command.kind) {
      case 'push-debug': return this.call('pushDebugGroup', command.label);
      case 'pop-debug': return this.call('popDebugGroup');
      case 'begin-render-pass':
        this.pipeline = undefined;
        this.groups.clear();
        return this.call('beginRenderPass', lowerRenderPass(command.descriptor, this.owner));
      case 'end-render-pass': return this.call('endRenderPass');
      case 'set-pipeline': return this.applyPipeline(command.pipeline as WebGL2RenderPipeline);
      case 'set-bind-group': {
        const bound = { group: command.group, dynamicOffsets: command.dynamicOffsets };
        this.groups.set(command.index, bound);
        if (this.pipeline !== undefined) this.applyGroup(command.index, bound, this.pipeline);
        return;
      }
      case 'set-vertex-buffer':
        return this.state.applyVertexBuffer(
          command.slot, getWebGL2Handle(command.buffer, this.owner), command.offset, command.size
        );
      case 'set-index-buffer':
        return this.state.applyIndexBuffer(
          getWebGL2Handle(command.buffer, this.owner), command.indexFormat, command.offset, command.size
        );
      case 'set-viewport':
        return this.state.applyViewport([
          command.x, command.y, command.width, command.height, command.minDepth, command.maxDepth
        ]);
      case 'set-scissor':
        return this.state.applyScissor([command.x, command.y, command.width, command.height]);
      case 'draw':
        this.metrics.recordLogicalDraw();
        this.call('draw', command.vertexCount, command.instanceCount, command.firstVertex, command.firstInstance);
        this.metrics.recordPhysicalDraw();
        return;
      case 'draw-indexed':
        this.metrics.recordLogicalDraw();
        this.call(
          'drawIndexed', command.indexCount, command.instanceCount,
          command.firstIndex, command.baseVertex, command.firstInstance
        );
        this.metrics.recordPhysicalDraw();
        return;
      case 'copy-buffer-to-buffer':
        return this.call(
          'copyBufferToBuffer', getWebGL2Handle(command.source, this.owner), command.sourceOffset,
          getWebGL2Handle(command.destination, this.owner), command.destinationOffset, command.size
        );
      case 'copy-texture-to-texture':
        return this.call(
          'copyTextureToTexture', lowerTextureCopy(command.source, this.owner),
          lowerTextureCopy(command.destination, this.owner), command.copySize
        );
    }
  }

  private applyPipeline(pipeline: WebGL2RenderPipeline): void {
    this.pipeline = pipeline;
    this.state.applyProgram(getWebGL2Handle(pipeline, this.owner));
    const primitive = pipeline.descriptor.primitive;
    this.state.applyRasterState(pipeline.descriptor, Object.freeze({
      topology: primitive?.topology ?? 'triangle-list',
      stripIndexFormat: primitive?.stripIndexFormat,
      frontFace: primitive?.frontFace ?? 'ccw',
      cullMode: primitive?.cullMode ?? 'none'
    }));
    const depthStencil = pipeline.descriptor.depthStencil;
    this.state.applyDepthStencilState(
      pipeline.descriptor,
      depthStencil === undefined
        ? Object.freeze({ enabled: false })
        : Object.freeze({ enabled: true, ...depthStencil })
    );
    for (const [index, group] of this.groups) this.applyGroup(index, group, pipeline);
  }

  private applyGroup(index: number, bound: BoundGroup, pipeline: WebGL2RenderPipeline): void {
    const dynamicOffsets = dynamicOffsetMap(bound.group, bound.dynamicOffsets);
    for (const entry of bound.group.descriptor.entries) {
      const manifest = pipeline.bindings.find((candidate) => candidate.group === index && candidate.binding === entry.binding);
      if (manifest === undefined) throw new Error(`WebGL2 pipeline has no binding for group ${index} binding ${entry.binding}.`);
      const binding = pipeline.bindings.filter((candidate) => candidate.kind === manifest.kind)
        .findIndex((candidate) => candidate === manifest);
      this.applyBinding(binding, entry.resource, dynamicOffsets.get(entry.binding) ?? 0);
    }
  }

  private applyBinding(binding: number, resource: GPUBindingResource, dynamicOffset: number): void {
    if ('buffer' in resource) {
      const baseOffset = resource.offset ?? 0;
      const offset = baseOffset + dynamicOffset;
      const size = resource.size ?? resource.buffer.size - baseOffset;
      this.state.applyUniformBuffer(binding, getWebGL2Handle(resource.buffer, this.owner), offset, size);
      return;
    }
    const handle = getWebGL2Handle(resource, this.owner);
    if (resource.kind === 'texture-view') this.state.applyTexture(binding, handle);
    else this.state.applySampler(binding, handle);
  }

  private call(name: keyof WebGL2NativeContextPort, ...args: unknown[]): void {
    const operation = this.native[name];
    if (typeof operation !== 'function') throw new Error(`Native WebGL2 context does not support ${String(name)}.`);
    (operation as (...values: unknown[]) => void).call(this.native, ...args);
    this.metrics.recordGLCall();
  }
}

function dynamicOffsetMap(group: RHIBindGroup, offsets: readonly number[]): ReadonlyMap<number, number> {
  const result = new Map<number, number>();
  let index = 0;
  for (const entry of group.layout.descriptor.entries) {
    if (entry.buffer?.hasDynamicOffset === true) result.set(entry.binding, offsets[index++] ?? 0);
  }
  return result;
}

function lowerRenderPass(
  descriptor: Extract<WebGL2ReplayCommand, { kind: 'begin-render-pass' }>['descriptor'],
  owner: WebGL2DeviceOwner
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    ...(descriptor.label === undefined ? {} : { label: descriptor.label }),
    colorAttachments: Object.freeze(descriptor.colorAttachments.map((attachment) => Object.freeze({
      ...attachment,
      view: getWebGL2Handle(attachment.view, owner),
      ...(attachment.resolveTarget === undefined ? {} : {
        resolveTarget: getWebGL2Handle(attachment.resolveTarget, owner)
      })
    }))),
    ...(descriptor.depthStencilAttachment === undefined ? {} : {
      depthStencilAttachment: Object.freeze({
        ...descriptor.depthStencilAttachment,
        view: getWebGL2Handle(descriptor.depthStencilAttachment.view, owner)
      })
    })
  });
}

function lowerTextureCopy(copy: WebGL2ImageCopyTexture, owner: WebGL2DeviceOwner): Readonly<Record<string, unknown>> {
  return Object.freeze({
    texture: getWebGL2Handle(copy.texture, owner),
    mipLevel: copy.mipLevel,
    origin: copy.origin,
    aspect: copy.aspect
  });
}
