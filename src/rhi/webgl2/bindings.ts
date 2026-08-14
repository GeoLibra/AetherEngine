import type {
  GPUBindGroupDescriptor,
  GPUBindingResource,
  GPUBufferBinding,
  GPUPipelineLayoutDescriptor,
  RHIBindGroup,
  RHIBindGroupLayout,
  RHIPipelineLayout,
  RHIResource
} from '../contracts/resource';
import type { GPUBindGroupLayoutDescriptor, GPUBindGroupLayoutEntry } from '../contracts/webgpu';
import { WebGL2ResourceBase, assertWebGL2Resource } from './resource';
import type { WebGL2DeviceOwner } from './resource-types';

export class WebGL2BindGroupLayout extends WebGL2ResourceBase implements RHIBindGroupLayout {
  readonly kind = 'bind-group-layout';
  readonly descriptor: Readonly<GPUBindGroupLayoutDescriptor>;
  readonly dynamicBindingCount: number;
  private readonly entries = new Map<number, GPUBindGroupLayoutEntry>();
  constructor(id: number, owner: WebGL2DeviceOwner, descriptor: GPUBindGroupLayoutDescriptor) {
    super(id, owner, Object.freeze({}), descriptor.label, false);
    const snapshot = descriptor.entries.map((entry) =>
      Object.freeze({
        ...entry,
        ...(entry.buffer === undefined ? {} : { buffer: Object.freeze({ ...entry.buffer }) }),
        ...(entry.texture === undefined ? {} : { texture: Object.freeze({ ...entry.texture }) }),
        ...(entry.sampler === undefined ? {} : { sampler: Object.freeze({ ...entry.sampler }) })
      })
    );
    validateLayoutEntries(snapshot);
    this.descriptor = Object.freeze({
      ...(descriptor.label === undefined ? {} : { label: descriptor.label }),
      entries: Object.freeze(snapshot)
    });
    for (const entry of snapshot) this.entries.set(entry.binding, entry);
    this.dynamicBindingCount = snapshot.filter(
      (entry) => entry.buffer?.hasDynamicOffset === true
    ).length;
  }
  getEntry(binding: number): GPUBindGroupLayoutEntry | undefined {
    return this.entries.get(binding);
  }
}

export function getWebGL2BindGroupResources(bindGroup: RHIBindGroup): readonly RHIResource[] {
  return bindGroup.descriptor.entries.map((entry) => {
    const resource = entry.resource;
    return 'buffer' in resource ? resource.buffer : resource;
  });
}

export function validateWebGL2BindGroupSlot(
  index: number,
  bindGroup: RHIBindGroup,
  dynamicOffsets: readonly number[],
  owner: WebGL2DeviceOwner,
  pipelineLayout?: RHIPipelineLayout
): void {
  if (!Number.isInteger(index) || index < 0)
    throw new Error(`Bind group index ${index} must be non-negative.`);
  assertWebGL2Resource(bindGroup, owner);
  if (dynamicOffsets.length !== bindGroup.dynamicBindingCount) {
    throw new Error(
      `Bind group slot ${index} requires ${bindGroup.dynamicBindingCount} dynamic offsets, received ${dynamicOffsets.length}.`
    );
  }
  const alignment = owner.native.limits.uniformBufferOffsetAlignment ?? 1;
  for (let index = 0; index < dynamicOffsets.length; index += 1) {
    const offset = dynamicOffsets[index];
    if (offset === undefined) {
      throw new Error(`Dynamic uniform buffer offset at index ${index} is missing.`);
    }
    if (!Number.isInteger(offset) || offset < 0 || offset % alignment !== 0) {
      throw new Error(`Dynamic uniform buffer offset ${offset} is not aligned to ${alignment}.`);
    }
  }
  if (pipelineLayout !== undefined) {
    assertWebGL2Resource(pipelineLayout, owner);
    const expected = pipelineLayout.bindGroupLayouts[index];
    if (expected === undefined)
      throw new Error(`Pipeline layout does not declare bind group slot ${index}.`);
    if (bindGroup.layout !== expected)
      throw new Error(`Bind group slot ${index} is incompatible with the current pipeline layout.`);
  }
  validateDynamicBufferRanges(bindGroup, dynamicOffsets);
}

function validateDynamicBufferRanges(
  bindGroup: RHIBindGroup,
  dynamicOffsets: readonly number[]
): void {
  let dynamicIndex = 0;
  for (const layoutEntry of bindGroup.layout.descriptor.entries) {
    if (layoutEntry.buffer?.hasDynamicOffset !== true) continue;
    const entry = bindGroup.descriptor.entries.find(
      (candidate) => candidate.binding === layoutEntry.binding
    );
    const resource = requireDynamicBufferResource(entry?.resource, layoutEntry.binding);
    const dynamicOffset = dynamicOffsets[dynamicIndex++]!;
    const baseOffset = resource.offset ?? 0;
    const size = resource.size ?? resource.buffer.size - baseOffset;
    if (baseOffset + dynamicOffset + size > resource.buffer.size) {
      throw new Error(`Dynamic buffer range exceeds buffer size ${resource.buffer.size}.`);
    }
  }
}

export function requireDynamicBufferResource(
  resource: GPUBindingResource | undefined,
  binding: number
): GPUBufferBinding {
  if (resource === undefined) {
    throw new Error(
      `WebGL2 bind group invariant failed: dynamic binding ${binding} has no resource.`
    );
  }
  if (!('buffer' in resource)) {
    throw new Error(
      `WebGL2 bind group invariant failed: dynamic binding ${binding} is not a buffer.`
    );
  }
  return resource;
}

export class WebGL2PipelineLayout extends WebGL2ResourceBase implements RHIPipelineLayout {
  readonly kind = 'pipeline-layout';
  readonly descriptor: Readonly<GPUPipelineLayoutDescriptor>;
  readonly bindGroupLayouts: readonly RHIBindGroupLayout[];
  constructor(id: number, owner: WebGL2DeviceOwner, descriptor: GPUPipelineLayoutDescriptor) {
    super(id, owner, Object.freeze({}), descriptor.label, false);
    for (const layout of descriptor.bindGroupLayouts) assertWebGL2Resource(layout, owner);
    this.bindGroupLayouts = Object.freeze([...descriptor.bindGroupLayouts]);
    this.descriptor = Object.freeze({
      ...(descriptor.label === undefined ? {} : { label: descriptor.label }),
      bindGroupLayouts: this.bindGroupLayouts
    });
  }
}

export class WebGL2BindGroup extends WebGL2ResourceBase implements RHIBindGroup {
  readonly kind = 'bind-group';
  readonly descriptor: Readonly<GPUBindGroupDescriptor>;
  readonly layout: RHIBindGroupLayout;
  readonly dynamicBindingCount: number;
  constructor(id: number, owner: WebGL2DeviceOwner, descriptor: GPUBindGroupDescriptor) {
    super(id, owner, Object.freeze({}), descriptor.label, false);
    assertWebGL2Resource(descriptor.layout, owner);
    validateGroupEntries(descriptor, owner);
    this.layout = descriptor.layout;
    this.dynamicBindingCount = descriptor.layout.dynamicBindingCount;
    this.descriptor = Object.freeze({
      ...(descriptor.label === undefined ? {} : { label: descriptor.label }),
      layout: descriptor.layout,
      entries: Object.freeze(
        descriptor.entries.map((entry) =>
          Object.freeze({
            binding: entry.binding,
            resource: snapshotResource(entry.resource)
          })
        )
      )
    });
  }
}

function validateLayoutEntries(entries: readonly GPUBindGroupLayoutEntry[]): void {
  const seen = new Set<number>();
  for (const entry of entries) {
    if (!Number.isInteger(entry.binding) || entry.binding < 0)
      throw new Error(`Binding ${entry.binding} must be non-negative.`);
    if (seen.has(entry.binding))
      throw new Error(`Bind group layout contains duplicate binding ${entry.binding}.`);
    seen.add(entry.binding);
    const kinds = [entry.buffer, entry.texture, entry.sampler].filter(
      (value) => value !== undefined
    ).length;
    if (kinds !== 1)
      throw new Error(
        `Bind group layout binding ${entry.binding} must declare exactly one WebGL2 resource.`
      );
  }
}

function validateGroupEntries(descriptor: GPUBindGroupDescriptor, owner: WebGL2DeviceOwner): void {
  const provided = new Map(descriptor.entries.map((entry) => [entry.binding, entry.resource]));
  for (const layoutEntry of descriptor.layout.descriptor.entries) {
    const resource = provided.get(layoutEntry.binding);
    if (resource === undefined)
      throw new Error(`Bind group is missing resource for binding ${layoutEntry.binding}.`);
    validateResource(layoutEntry, resource, owner);
    provided.delete(layoutEntry.binding);
  }
  const extra = provided.keys().next();
  if (!extra.done)
    throw new Error(`Bind group provides resource for undeclared binding ${extra.value}.`);
}

function validateResource(
  entry: GPUBindGroupLayoutEntry,
  resource: GPUBindingResource,
  owner: WebGL2DeviceOwner
): void {
  if (entry.buffer !== undefined) {
    if (!('buffer' in resource))
      throw new Error(`Binding ${entry.binding} expects a buffer resource.`);
    assertWebGL2Resource(resource.buffer, owner);
    const offset = resource.offset ?? 0;
    const size = resource.size ?? resource.buffer.size - offset;
    if (
      !Number.isInteger(offset) ||
      !Number.isInteger(size) ||
      offset < 0 ||
      size < 0 ||
      offset + size > resource.buffer.size
    ) {
      throw new Error(
        `Buffer range ${offset}..${offset + size} is outside buffer size ${resource.buffer.size}.`
      );
    }
    const alignment = owner.native.limits.uniformBufferOffsetAlignment ?? 1;
    if (offset % alignment !== 0) {
      throw new Error(
        `Uniform buffer binding ${entry.binding} offset ${offset} is not aligned to ${alignment}.`
      );
    }
    if (entry.buffer.minBindingSize !== undefined && size < entry.buffer.minBindingSize) {
      throw new Error(
        `Buffer binding size ${size} is smaller than required minBindingSize ${entry.buffer.minBindingSize}.`
      );
    }
    return;
  }
  if ('buffer' in resource)
    throw new Error(`Binding ${entry.binding} expects a texture or sampler resource.`);
  assertWebGL2Resource(resource, owner);
  if (entry.texture !== undefined && resource.kind !== 'texture-view')
    throw new Error(`Binding ${entry.binding} expects a texture view.`);
  if (entry.sampler !== undefined && resource.kind !== 'sampler')
    throw new Error(`Binding ${entry.binding} expects a sampler.`);
}

function snapshotResource(resource: GPUBindingResource): GPUBindingResource {
  if ('buffer' in resource) return Object.freeze({ ...resource }) as GPUBufferBinding;
  return resource;
}
