import { assertBufferUnmapped, validateBufferRange } from './buffer';
import { assertResourceLive, assertResourceOwnedBy, NullResourceBase } from './resource';
import type { NullDeviceOwner } from './resource';
import type {
  GPUBindGroupDescriptor,
  GPUBindGroupEntry,
  GPUBindGroupLayoutDescriptor,
  GPUBindGroupLayoutEntry,
  GPUBindingResource,
  GPUBufferBinding,
  GPUPipelineLayoutDescriptor,
  GPUShaderModuleDescriptor,
  RHIBindGroup,
  RHIBindGroupLayout,
  RHIPipelineLayout,
  RHIResource,
  RHIShaderModule
} from '../contracts';

export class NullShaderModule extends NullResourceBase implements RHIShaderModule {
  readonly kind = 'shader-module';
  readonly descriptor: Readonly<GPUShaderModuleDescriptor>;

  constructor(id: number, owner: NullDeviceOwner, descriptor: GPUShaderModuleDescriptor) {
    super(id, owner, descriptor.label);
    if (typeof descriptor.code !== 'string' || descriptor.code.length === 0) {
      throw new Error('Shader module descriptor requires non-empty code.');
    }
    this.descriptor = { ...descriptor };
  }
}

export class NullBindGroupLayout extends NullResourceBase implements RHIBindGroupLayout {
  readonly kind = 'bind-group-layout';
  readonly descriptor: Readonly<GPUBindGroupLayoutDescriptor>;
  readonly dynamicBindingCount: number;
  private readonly entriesByBinding = new Map<number, GPUBindGroupLayoutEntry>();

  constructor(id: number, owner: NullDeviceOwner, descriptor: GPUBindGroupLayoutDescriptor) {
    super(id, owner, descriptor.label);
    validateBindGroupLayoutDescriptor(descriptor);
    const entries = descriptor.entries.map(cloneBindGroupLayoutEntry);
    const clone: GPUBindGroupLayoutDescriptor = { entries };
    if (descriptor.label !== undefined) {
      clone.label = descriptor.label;
    }
    this.descriptor = clone;
    for (const entry of entries) {
      this.entriesByBinding.set(entry.binding, entry);
    }
    this.dynamicBindingCount = entries.filter(
      (entry) => entry.buffer?.hasDynamicOffset === true
    ).length;
  }

  getEntry(binding: number): GPUBindGroupLayoutEntry | undefined {
    const entry = this.entriesByBinding.get(binding);
    return entry ? cloneBindGroupLayoutEntry(entry) : undefined;
  }
}

export class NullPipelineLayout extends NullResourceBase implements RHIPipelineLayout {
  readonly kind = 'pipeline-layout';
  readonly descriptor: Readonly<GPUPipelineLayoutDescriptor>;
  readonly bindGroupLayouts: readonly RHIBindGroupLayout[];

  constructor(id: number, owner: NullDeviceOwner, descriptor: GPUPipelineLayoutDescriptor) {
    super(id, owner, descriptor.label);
    for (const layout of descriptor.bindGroupLayouts) {
      assertResourceOwnedBy(layout, owner);
      assertResourceLive(layout);
    }
    this.bindGroupLayouts = [...descriptor.bindGroupLayouts];
    const clone: GPUPipelineLayoutDescriptor = { bindGroupLayouts: this.bindGroupLayouts };
    if (descriptor.label !== undefined) {
      clone.label = descriptor.label;
    }
    this.descriptor = clone;
  }
}

export class NullBindGroup extends NullResourceBase implements RHIBindGroup {
  readonly kind = 'bind-group';
  readonly descriptor: Readonly<GPUBindGroupDescriptor>;
  readonly layout: RHIBindGroupLayout;
  readonly dynamicBindingCount: number;

  constructor(id: number, owner: NullDeviceOwner, descriptor: GPUBindGroupDescriptor) {
    super(id, owner, descriptor.label);
    validateBindGroupDescriptor(descriptor, owner);
    this.layout = descriptor.layout;
    this.dynamicBindingCount = descriptor.layout.dynamicBindingCount;
    const clone: GPUBindGroupDescriptor = {
      layout: descriptor.layout,
      entries: descriptor.entries.map(cloneBindGroupEntry)
    };
    if (descriptor.label !== undefined) {
      clone.label = descriptor.label;
    }
    this.descriptor = clone;
  }
}

export function validatePipelineLayout(
  layout: RHIPipelineLayout | undefined,
  owner: NullDeviceOwner
): void {
  if (layout === undefined) {
    return;
  }
  assertResourceOwnedBy(layout, owner);
  assertResourceLive(layout);
  for (const bindGroupLayout of layout.bindGroupLayouts) {
    assertResourceOwnedBy(bindGroupLayout, owner);
    assertResourceLive(bindGroupLayout);
  }
}

export function validateBindGroupSlot(
  index: number,
  bindGroup: RHIBindGroup,
  dynamicOffsets: readonly number[],
  owner: NullDeviceOwner,
  pipelineLayout: RHIPipelineLayout | undefined
): void {
  if (!Number.isInteger(index) || index < 0) {
    throw new Error(`Bind group slot ${index} must be a non-negative integer.`);
  }
  assertResourceOwnedBy(bindGroup, owner);
  assertResourceLive(bindGroup);
  assertResourceOwnedBy(bindGroup.layout, owner);
  assertResourceLive(bindGroup.layout);
  validateBindGroupContentsLive(bindGroup, owner);

  if (pipelineLayout !== undefined) {
    assertResourceOwnedBy(pipelineLayout, owner);
    assertResourceLive(pipelineLayout);
    if (pipelineLayout.bindGroupLayouts[index] !== bindGroup.layout) {
      throw new Error(
        `Bind group layout at slot ${index} is not compatible with the current pipeline layout.`
      );
    }
  }

  if (dynamicOffsets.length !== bindGroup.dynamicBindingCount) {
    throw new Error(
      `Bind group at slot ${index} requires ${bindGroup.dynamicBindingCount} dynamic offsets, received ${dynamicOffsets.length}.`
    );
  }
  for (const offset of dynamicOffsets) {
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error(`Dynamic offset ${offset} must be a non-negative integer.`);
    }
  }
  validateDynamicOffsetRanges(bindGroup, dynamicOffsets);
}

export function getBindGroupResources(bindGroup: RHIBindGroup): readonly RHIResource[] {
  return bindGroup.descriptor.entries.map((entry) => {
    const resource = entry.resource;
    return isBufferBinding(resource) ? resource.buffer : resource;
  });
}

function validateBindGroupLayoutDescriptor(descriptor: GPUBindGroupLayoutDescriptor): void {
  const bindings = new Set<number>();
  for (const entry of descriptor.entries) {
    if (!Number.isInteger(entry.binding) || entry.binding < 0) {
      throw new Error(`Bind group layout binding ${entry.binding} must be a non-negative integer.`);
    }
    if (bindings.has(entry.binding)) {
      throw new Error(`Bind group layout contains duplicate binding ${entry.binding}.`);
    }
    bindings.add(entry.binding);

    const resourceKinds = [
      entry.buffer !== undefined,
      entry.sampler !== undefined,
      entry.texture !== undefined,
      entry.storageTexture !== undefined
    ].filter(Boolean).length;
    if (resourceKinds !== 1) {
      throw new Error(
        `Bind group layout binding ${entry.binding} must declare exactly one resource layout.`
      );
    }
  }
}

function validateBindGroupDescriptor(
  descriptor: GPUBindGroupDescriptor,
  owner: NullDeviceOwner
): void {
  assertResourceOwnedBy(descriptor.layout, owner);
  assertResourceLive(descriptor.layout);

  const entries = new Map<number, GPUBindGroupEntry>();
  for (const entry of descriptor.entries) {
    if (entries.has(entry.binding)) {
      throw new Error(`Bind group contains duplicate binding ${entry.binding}.`);
    }
    entries.set(entry.binding, entry);
  }

  for (const layoutEntry of descriptor.layout.descriptor.entries) {
    const entry = entries.get(layoutEntry.binding);
    if (entry === undefined) {
      throw new Error(`Bind group is missing resource for binding ${layoutEntry.binding}.`);
    }
    validateBindingResource(layoutEntry, entry.resource, owner);
    entries.delete(layoutEntry.binding);
  }

  const extra = entries.keys().next();
  if (!extra.done) {
    throw new Error(`Bind group provides resource for undeclared binding ${extra.value}.`);
  }
}

function validateBindingResource(
  layoutEntry: GPUBindGroupLayoutEntry,
  resource: GPUBindingResource,
  owner: NullDeviceOwner
): void {
  if (!isObjectResource(resource)) {
    throw new Error(`Binding ${layoutEntry.binding} resource is missing or invalid.`);
  }

  if (layoutEntry.buffer !== undefined) {
    if (!isBufferBinding(resource)) {
      if (typeof resource === 'object' && resource !== null && 'buffer' in resource) {
        throw new Error(`Binding ${layoutEntry.binding} resource is missing or invalid.`);
      }
      throw new Error(`Binding ${layoutEntry.binding} expects a buffer resource.`);
    }
    assertResourceOwnedBy(resource.buffer, owner);
    assertResourceLive(resource.buffer);
    assertBufferUnmapped(resource.buffer);
    validateBufferBinding(resource, layoutEntry.buffer.minBindingSize);
    return;
  }

  if (layoutEntry.sampler !== undefined) {
    if (isBufferBinding(resource) || resource.kind !== 'sampler') {
      throw new Error(`Binding ${layoutEntry.binding} expects a sampler resource.`);
    }
    assertResourceOwnedBy(resource, owner);
    assertResourceLive(resource);
    return;
  }

  if (layoutEntry.texture !== undefined || layoutEntry.storageTexture !== undefined) {
    if (isBufferBinding(resource) || resource.kind !== 'texture-view') {
      throw new Error(`Binding ${layoutEntry.binding} expects a texture view resource.`);
    }
    assertResourceOwnedBy(resource, owner);
    assertResourceLive(resource);
  }
}

function validateBufferBinding(binding: GPUBufferBinding, minBindingSize?: number): void {
  const offset = binding.offset ?? 0;
  const size = binding.size ?? binding.buffer.size - offset;
  validateBufferRange(offset, size, binding.buffer.size);
  if (minBindingSize !== undefined && size < minBindingSize) {
    throw new Error(
      `Buffer binding size ${size} is smaller than required minBindingSize ${minBindingSize}.`
    );
  }
}

function isBufferBinding(resource: GPUBindingResource): resource is GPUBufferBinding {
  return (
    typeof resource === 'object' &&
    resource !== null &&
    'buffer' in resource &&
    typeof resource.buffer === 'object' &&
    resource.buffer !== null
  );
}

function isObjectResource(resource: GPUBindingResource): resource is GPUBindingResource {
  return typeof resource === 'object' && resource !== null;
}

function validateBindGroupContentsLive(bindGroup: RHIBindGroup, owner: NullDeviceOwner): void {
  for (const descriptorEntry of bindGroup.descriptor.entries) {
    const layoutEntry = bindGroup.layout.getEntry(descriptorEntry.binding);
    if (layoutEntry === undefined) {
      throw new Error(`Bind group references undeclared binding ${descriptorEntry.binding}.`);
    }
    validateBindingResource(layoutEntry, descriptorEntry.resource, owner);
  }
}

function validateDynamicOffsetRanges(
  bindGroup: RHIBindGroup,
  dynamicOffsets: readonly number[]
): void {
  const dynamicLayoutEntries = bindGroup.layout.descriptor.entries
    .filter((entry) => entry.buffer?.hasDynamicOffset === true)
    .sort((left, right) => left.binding - right.binding);
  dynamicLayoutEntries.forEach((layoutEntry, index) => {
    const dynamicOffset = dynamicOffsets[index] ?? 0;
    const descriptorEntry = bindGroup.descriptor.entries.find(
      (entry) => entry.binding === layoutEntry.binding
    );
    if (descriptorEntry === undefined || !isBufferBinding(descriptorEntry.resource)) {
      return;
    }
    const binding = descriptorEntry.resource;
    const baseOffset = binding.offset ?? 0;
    const size = binding.size ?? binding.buffer.size - baseOffset;
    validateBufferRange(baseOffset + dynamicOffset, size, binding.buffer.size);
  });
}

function cloneBindGroupLayoutEntry(entry: GPUBindGroupLayoutEntry): GPUBindGroupLayoutEntry {
  const clone: GPUBindGroupLayoutEntry = {
    binding: entry.binding,
    visibility: entry.visibility
  };
  if (entry.buffer !== undefined) {
    clone.buffer = { ...entry.buffer };
  }
  if (entry.sampler !== undefined) {
    clone.sampler = { ...entry.sampler };
  }
  if (entry.texture !== undefined) {
    clone.texture = { ...entry.texture };
  }
  if (entry.storageTexture !== undefined) {
    clone.storageTexture = { ...entry.storageTexture };
  }
  return clone;
}

function cloneBindGroupEntry(entry: GPUBindGroupEntry): GPUBindGroupEntry {
  return {
    binding: entry.binding,
    resource: cloneBindingResource(entry.resource)
  };
}

function cloneBindingResource(resource: GPUBindingResource): GPUBindingResource {
  if (!isBufferBinding(resource)) {
    return resource;
  }
  const clone: GPUBufferBinding = { buffer: resource.buffer };
  if (resource.offset !== undefined) {
    clone.offset = resource.offset;
  }
  if (resource.size !== undefined) {
    clone.size = resource.size;
  }
  return clone;
}
