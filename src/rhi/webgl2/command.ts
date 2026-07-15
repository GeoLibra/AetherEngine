import type {
  GPUCommandBufferDescriptor,
  GPUCommandEncoderDescriptor,
  GPUColor,
  GPUComputePassDescriptor,
  GPUExtent3D,
  GPUImageCopyTexture,
  RHICommandBuffer,
  RHICommandEncoder,
  RHICommandRecord,
  RHICommandStats,
  RHIComputePassEncoder,
  RHIBuffer,
  RHIResource,
  RHIRenderPassDescriptor,
  RHIRenderPassEncoder
} from '../contracts';
import { toResourceRef } from '../core/resource-ref';
import { cloneCommandStats, createCommandStats, recordDraw, recordIndexedDraw } from '../core/stats';
import { WebGL2Buffer, WebGL2ResourceBase, WebGL2Texture, assertWebGL2Resource, normalizeExtent } from './resource';
import type { WebGL2DeviceOwner } from './resource-types';
import type { WebGL2ImageCopyTexture, WebGL2RenderPassSnapshot, WebGL2ReplayCommand } from './command-types';
import { WebGL2RenderPassEncoder, type WebGL2PassController } from './pass';
import { throwWebGL2Unsupported } from './unsupported';

export class WebGL2CommandBuffer extends WebGL2ResourceBase implements RHICommandBuffer {
  readonly kind = 'command-buffer';
  private submitted = false;

  constructor(
    id: number,
    owner: WebGL2DeviceOwner,
    label: string | undefined,
    private readonly replayCommands: readonly WebGL2ReplayCommand[],
    private readonly records: readonly RHICommandRecord[],
    private readonly stats: RHICommandStats,
    private readonly leasedResources: readonly RHIResource[]
  ) {
    super(id, owner, Object.freeze({}), label, false);
  }

  getReplayCommands(): readonly WebGL2ReplayCommand[] {
    assertWebGL2Resource(this, this.owner);
    return this.replayCommands;
  }

  getLeasedResources(): readonly RHIResource[] { return this.leasedResources; }
  assertReadyForSubmit(): void {
    assertWebGL2Resource(this, this.owner);
    if (this.submitted) throw new Error(`Command buffer "${this.label ?? 'command-buffer'}" has already been submitted.`);
  }
  markSubmitted(): void { this.assertReadyForSubmit(); this.submitted = true; }
  getStats(): RHICommandStats { assertWebGL2Resource(this, this.owner); return cloneCommandStats(this.stats); }
  getCommandStream(): readonly RHICommandRecord[] {
    assertWebGL2Resource(this, this.owner);
    return this.records.map(cloneCommandRecord);
  }
  toCommandStreamJSON(): string { return JSON.stringify(this.getCommandStream()); }
}

export class WebGL2CommandEncoder implements RHICommandEncoder, WebGL2PassController {
  private readonly replayCommands: WebGL2ReplayCommand[] = [];
  private readonly records: RHICommandRecord[] = [];
  private readonly stats = createCommandStats();
  private readonly leasedResources = new Set<RHIResource>();
  private readonly label: string | undefined;
  private activePass: WebGL2RenderPassEncoder | undefined;
  private finished = false;
  private debugGroupDepth = 0;

  constructor(
    private readonly id: number,
    readonly ownerToken: WebGL2DeviceOwner,
    descriptor: GPUCommandEncoderDescriptor
  ) { this.label = descriptor.label; }

  beginRenderPass(descriptor: RHIRenderPassDescriptor): RHIRenderPassEncoder {
    this.ensureCanBeginPass('render');
    const passDescriptor = snapshotPortableRenderPass(descriptor, this.ownerToken);
    const replayDescriptor = snapshotReplayRenderPass(passDescriptor);
    for (const attachment of passDescriptor.colorAttachments) {
      this.lease(attachment.view);
      if (attachment.resolveTarget !== undefined) this.lease(attachment.resolveTarget);
    }
    if (passDescriptor.depthStencilAttachment !== undefined) this.lease(passDescriptor.depthStencilAttachment.view);
    const pass = new WebGL2RenderPassEncoder(this, passDescriptor);
    this.stats.renderPasses += 1;
    this.record(
      Object.freeze({ kind: 'begin-render-pass', descriptor: replayDescriptor }),
      { kind: 'beginRenderPass', colorAttachmentCount: passDescriptor.colorAttachments.length,
        ...(passDescriptor.label === undefined ? {} : { label: passDescriptor.label }) }
    );
    this.activePass = pass;
    return pass;
  }

  beginComputePass(_descriptor: GPUComputePassDescriptor = {}): RHIComputePassEncoder {
    this.ensureCanBeginPass('compute');
    return throwWebGL2Unsupported(this.ownerToken.capabilities, 'compute', 'begin-compute-pass');
  }

  pushDebugGroup(label: string): void {
    this.ensureCanRecord();
    this.ensureNoActivePass('push an encoder debug group');
    this.debugGroupDepth += 1;
    this.record(
      Object.freeze({ kind: 'push-debug', scope: 'encoder', label }),
      { kind: 'pushDebugGroup', scope: 'encoder', label }
    );
  }

  popDebugGroup(): void {
    this.ensureCanRecord();
    this.ensureNoActivePass('pop an encoder debug group');
    if (this.debugGroupDepth === 0) throw new Error(`${this.encoderName} has no debug group to pop.`);
    this.debugGroupDepth -= 1;
    this.record(
      Object.freeze({ kind: 'pop-debug', scope: 'encoder' }),
      { kind: 'popDebugGroup', scope: 'encoder' }
    );
  }

  copyBufferToBuffer(source: RHIBuffer, sourceOffset: number, destination: RHIBuffer, destinationOffset: number, size: number): void {
    this.ensureCanRecord();
    this.ensureNoActivePass('copy buffers');
    const sourceBuffer = requireBuffer(source, this.ownerToken);
    const destinationBuffer = requireBuffer(destination, this.ownerToken);
    validateBufferRange(sourceOffset, size, sourceBuffer.size);
    validateBufferRange(destinationOffset, size, destinationBuffer.size);
    this.lease(sourceBuffer);
    this.lease(destinationBuffer);
    this.stats.copy.copyBufferToBuffer += 1;
    this.record(
      Object.freeze({ kind: 'copy-buffer-to-buffer', source: sourceBuffer, sourceOffset, destination: destinationBuffer, destinationOffset, size }),
      { kind: 'copyBufferToBuffer', source: toResourceRef(sourceBuffer), sourceOffset,
        destination: toResourceRef(destinationBuffer), destinationOffset, size }
    );
  }

  copyTextureToTexture(source: GPUImageCopyTexture, destination: GPUImageCopyTexture, copySize: GPUExtent3D): void {
    this.ensureCanRecord();
    this.ensureNoActivePass('copy textures');
    const extent = validateExtent(copySize);
    const normalizedSource = validateTextureCopy(source, extent, this.ownerToken);
    const normalizedDestination = validateTextureCopy(destination, extent, this.ownerToken);
    this.lease(normalizedSource.texture);
    this.lease(normalizedDestination.texture);
    this.stats.copy.copyTextureToTexture += 1;
    this.record(
      Object.freeze({ kind: 'copy-texture-to-texture', source: normalizedSource, destination: normalizedDestination, copySize: extent }),
      { kind: 'copyTextureToTexture', source: portableTextureCopy(normalizedSource),
        destination: portableTextureCopy(normalizedDestination), copySize: extent }
    );
  }

  finish(descriptor: GPUCommandBufferDescriptor = {}): RHICommandBuffer {
    this.ensureCanRecord();
    if (this.activePass !== undefined) throw new Error('Cannot finish command encoder while a pass is active.');
    if (this.debugGroupDepth > 0) throw new Error(`${this.encoderName} has unclosed debug groups.`);
    this.finished = true;
    return new WebGL2CommandBuffer(
      this.id, this.ownerToken, descriptor.label,
      Object.freeze([...this.replayCommands]),
      Object.freeze(this.records.map(cloneCommandRecord)),
      cloneCommandStats(this.stats),
      Object.freeze([...this.leasedResources])
    );
  }

  getStats(): RHICommandStats { return cloneCommandStats(this.stats); }
  record(replay: WebGL2ReplayCommand, portable: RHICommandRecord): void {
    this.replayCommands.push(replay);
    this.records.push(portable);
  }
  lease(resource: RHIResource): void { this.leasedResources.add(resource); }
  recordDraw(vertexCount: number, instanceCount: number, topology: Parameters<typeof recordDraw>[3]): void {
    recordDraw(this.stats, vertexCount, instanceCount, topology);
  }
  recordIndexedDraw(indexCount: number, instanceCount: number, topology: Parameters<typeof recordIndexedDraw>[3]): void {
    recordIndexedDraw(this.stats, indexCount, instanceCount, topology);
  }
  endPass(pass: WebGL2RenderPassEncoder): void {
    if (this.activePass !== pass) throw new Error('Cannot end a render pass that is not active.');
    this.activePass = undefined;
  }

  private ensureCanBeginPass(kind: 'render' | 'compute'): void {
    this.ensureCanRecord();
    if (this.activePass !== undefined) throw new Error(`Cannot begin a ${kind} pass while another pass is active.`);
  }
  private ensureCanRecord(): void {
    if (this.ownerToken.state !== 'live') throw new Error(`${this.encoderName} belongs to a lost device.`);
    if (this.finished) throw new Error(`${this.encoderName} has already finished.`);
  }
  private ensureNoActivePass(action: string): void {
    if (this.activePass !== undefined) throw new Error(`Cannot ${action} while a pass is active.`);
  }
  private get encoderName(): string { return `Command encoder "${this.label ?? this.id}"`; }
}

function snapshotPortableRenderPass(descriptor: RHIRenderPassDescriptor, owner: WebGL2DeviceOwner): RHIRenderPassDescriptor {
  const colorAttachments = descriptor.colorAttachments.map((attachment) => {
    assertWebGL2Resource(attachment.view, owner);
    if (attachment.resolveTarget !== undefined) assertWebGL2Resource(attachment.resolveTarget, owner);
    const clearValue = cloneColor(attachment.clearValue);
    return Object.freeze({
      ...attachment,
      ...(clearValue === undefined ? {} : { clearValue })
    });
  });
  const depth = descriptor.depthStencilAttachment;
  if (depth !== undefined) assertWebGL2Resource(depth.view, owner);
  return Object.freeze({
    ...(descriptor.label === undefined ? {} : { label: descriptor.label }),
    colorAttachments: Object.freeze(colorAttachments),
    ...(depth === undefined ? {} : { depthStencilAttachment: Object.freeze({ ...depth }) })
  });
}

function snapshotReplayRenderPass(descriptor: RHIRenderPassDescriptor): WebGL2RenderPassSnapshot {
  const colorAttachments = descriptor.colorAttachments.map((attachment) => {
    const { clearValue, ...rest } = attachment;
    return Object.freeze({
      ...rest,
      ...(clearValue === undefined ? {} : { clearValue: normalizeColor(clearValue) })
    });
  });
  const depth = descriptor.depthStencilAttachment;
  return Object.freeze({
    ...(descriptor.label === undefined ? {} : { label: descriptor.label }),
    colorAttachments: Object.freeze(colorAttachments),
    ...(depth === undefined ? {} : { depthStencilAttachment: Object.freeze({ ...depth }) })
  });
}

function cloneColor(color: GPUColor | undefined): GPUColor | undefined {
  if (color === undefined) return undefined;
  if (Array.isArray(color)) return Object.freeze([...color] as [number, number, number, number]);
  const object = color as { r: number; g: number; b: number; a: number };
  return Object.freeze({ ...object });
}

function normalizeColor(color: GPUColor): Readonly<{ r: number; g: number; b: number; a: number }> {
  if (Array.isArray(color)) return Object.freeze({ r: color[0], g: color[1], b: color[2], a: color[3] });
  const object = color as { r: number; g: number; b: number; a: number };
  return Object.freeze({ r: object.r, g: object.g, b: object.b, a: object.a });
}

function requireBuffer(buffer: RHIBuffer, owner: WebGL2DeviceOwner): WebGL2Buffer {
  const resource = assertWebGL2Resource(buffer, owner);
  if (!(resource instanceof WebGL2Buffer)) throw new Error('Command encoder requires a WebGL2 buffer.');
  return resource;
}

function validateBufferRange(offset: number, size: number, bufferSize: number): void {
  if (!Number.isInteger(offset) || !Number.isInteger(size) || offset < 0 || size < 0 || offset + size > bufferSize) {
    throw new Error(`Buffer range ${offset}..${offset + size} is outside buffer size ${bufferSize}.`);
  }
}

function validateExtent(size: GPUExtent3D) {
  const extent = normalizeExtent(size);
  if ([extent.width, extent.height, extent.depthOrArrayLayers].some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error('Texture copy size must contain non-negative integer dimensions.');
  }
  return extent;
}

function validateTextureCopy(copy: GPUImageCopyTexture, size: ReturnType<typeof validateExtent>, owner: WebGL2DeviceOwner): WebGL2ImageCopyTexture {
  const resource = assertWebGL2Resource(copy.texture, owner);
  if (!(resource instanceof WebGL2Texture)) throw new Error('Command encoder requires a WebGL2 texture.');
  const mipLevel = copy.mipLevel ?? 0;
  const mipCount = resource.descriptor.mipLevelCount ?? 1;
  if (!Number.isInteger(mipLevel) || mipLevel < 0 || mipLevel >= mipCount) throw new Error(`Texture mipLevel ${mipLevel} is outside mipLevelCount ${mipCount}.`);
  const origin = normalizeOrigin(copy.origin);
  const scale = 2 ** mipLevel;
  const width = Math.max(1, Math.floor(resource.width / scale));
  const height = Math.max(1, Math.floor(resource.height / scale));
  const depth = resource.descriptor.dimension === '3d'
    ? Math.max(1, Math.floor(resource.depthOrArrayLayers / scale)) : resource.depthOrArrayLayers;
  if (origin.x + size.width > width || origin.y + size.height > height || origin.z + size.depthOrArrayLayers > depth) {
    throw new Error(`Texture copy range exceeds texture "${resource.label ?? resource.id}" bounds.`);
  }
  return Object.freeze({ texture: resource, mipLevel, origin, aspect: copy.aspect ?? 'all' });
}

function normalizeOrigin(origin: GPUImageCopyTexture['origin']) {
  const tuple = Array.isArray(origin) ? origin : undefined;
  const object = tuple === undefined ? origin as { x?: number; y?: number; z?: number } | undefined : undefined;
  const value = { x: tuple?.[0] ?? object?.x ?? 0, y: tuple?.[1] ?? object?.y ?? 0, z: tuple?.[2] ?? object?.z ?? 0 };
  if ([value.x, value.y, value.z].some((coordinate) => !Number.isInteger(coordinate) || coordinate < 0)) {
    throw new Error('Texture copy origin must contain non-negative integer coordinates.');
  }
  return Object.freeze(value);
}

function portableTextureCopy(copy: WebGL2ImageCopyTexture) {
  return Object.freeze({ texture: toResourceRef(copy.texture), mipLevel: copy.mipLevel, origin: copy.origin, aspect: copy.aspect });
}

function cloneCommandRecord(record: RHICommandRecord): RHICommandRecord {
  return JSON.parse(JSON.stringify(record)) as RHICommandRecord;
}
