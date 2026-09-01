import { isRecord } from '../../core';
import type { GPUBindGroupEntry, RHIResource } from '../../rhi/contracts';
import type { CanonicalBindingLayoutEntry } from '../pipeline/types';
import type {
  MaterialBindGroupDiagnostic,
  MaterialBindGroupPreparationInput,
  MaterialBindGroupPreparationResult,
  PreparedMaterialBindGroupDescriptor
} from './types';
import type { BindingResourceKeyParts } from '../pipeline/types';

const EMPTY_BIND_GROUP_ENTRIES = Object.freeze([]);

/**
 * Correlates canonical layout coordinates with live RHI resources without creating objects.
 * Expected availability/generation failures are returned as typed unsupported diagnostics.
 */
export function prepareMaterialBindGroups(
  input: MaterialBindGroupPreparationInput
): MaterialBindGroupPreparationResult {
  const contextIssue = validateContext(input);
  if (contextIssue !== undefined) return unsupported(contextIssue);
  const resources = new Map(
    input.bindingKey.parts.resources.map((resource) => [locationKey(resource), resource])
  );
  const groups: PreparedMaterialBindGroupDescriptor[] = [];
  const highestGroup = input.plan.groups.at(-1)?.group ?? -1;
  const dynamicOffsetsByGroup = Array.from({ length: highestGroup + 1 }, () => [] as number[]);
  for (let index = 0; index < input.plan.dynamicOffsetOrder.length; index += 1) {
    const location = input.plan.dynamicOffsetOrder[index]!;
    const binding = input.plan.groups
      .find(({ group }) => group === location.group)
      ?.bindings.find((entry) => entry.binding === location.binding);
    if (
      binding === undefined ||
      (binding.kind !== 'uniform-buffer' && binding.kind !== 'storage-buffer') ||
      !binding.dynamicOffset ||
      dynamicOffsetsByGroup[location.group] === undefined
    )
      return unsupported(
        diagnostic(
          'binding-layout-incompatible',
          'Dynamic offset order references a non-dynamic binding coordinate.',
          location.group,
          location.binding
        )
      );
    dynamicOffsetsByGroup[location.group]!.push(input.bindingKey.parts.dynamicOffsets[index]!);
  }
  for (let group = 0; group <= highestGroup; group += 1) {
    const canonical = input.plan.groups.find((candidate) => candidate.group === group);
    const entries: GPUBindGroupEntry[] = [];
    for (const binding of canonical?.bindings ?? EMPTY_BIND_GROUP_ENTRIES) {
      const resolution = resolveEntry(input, binding, resources);
      if ('code' in resolution) return unsupported(resolution);
      entries.push(resolution);
    }
    const layout = input.deviceLayout.bindGroupLayouts[group];
    if (layout === undefined)
      return unsupported(
        diagnostic(
          'binding-layout-incompatible',
          'Device layout is missing a required bind-group coordinate.',
          group,
          0
        )
      );
    groups.push(
      Object.freeze({
        group,
        descriptor: Object.freeze({ layout, entries: Object.freeze(entries) })
      })
    );
  }
  const expectedResourceCount = input.plan.groups
    .flatMap((group) => group.bindings)
    .filter((entry) => entry.kind === 'texture' || entry.kind === 'sampler').length;
  if (resources.size !== expectedResourceCount)
    return unsupported(
      diagnostic(
        'binding-layout-incompatible',
        'Binding key contains resources outside the canonical layout.',
        0,
        0
      )
    );
  return Object.freeze({
    status: 'ready',
    prepared: Object.freeze({
      bindingKey: input.bindingKey,
      groups: Object.freeze(groups),
      dynamicOffsetsByGroup: Object.freeze(
        dynamicOffsetsByGroup.map((offsets) => Object.freeze(offsets))
      )
    })
  });
}

function validateContext(
  input: MaterialBindGroupPreparationInput
): MaterialBindGroupDiagnostic | undefined {
  if (input.bindingKey.parts.bindingLayoutHash !== input.plan.hash)
    return diagnostic(
      'binding-layout-incompatible',
      'Binding key does not identify the canonical binding layout.',
      0,
      0
    );
  if (
    input.deviceLayout.bindingLayoutId !== input.plan.id ||
    input.deviceLayout.bindingLayoutHash !== input.plan.hash
  )
    return diagnostic(
      'binding-layout-incompatible',
      'Device layout does not identify the canonical binding plan.',
      0,
      0
    );
  if (
    input.bindingKey.parts.deviceGeneration !== input.resolver.deviceGeneration ||
    input.deviceLayout.pipelineLayout.generation !== input.resolver.deviceGeneration ||
    input.deviceLayout.pipelineLayout.state !== 'live' ||
    input.deviceLayout.bindGroupLayouts.some(
      (layout) => layout.generation !== input.resolver.deviceGeneration || layout.state !== 'live'
    )
  )
    return diagnostic(
      'binding-device-generation-stale',
      'Binding preparation facts belong to different device generations.',
      0,
      0
    );
  if (input.bindingKey.parts.dynamicOffsets.length !== input.plan.dynamicOffsetOrder.length)
    return diagnostic(
      'binding-layout-incompatible',
      'Dynamic offset count does not match the canonical binding layout.',
      0,
      0
    );
  return undefined;
}

function resolveEntry(
  input: MaterialBindGroupPreparationInput,
  entry: CanonicalBindingLayoutEntry,
  resources: ReadonlyMap<string, BindingResourceKeyParts>
): GPUBindGroupEntry | MaterialBindGroupDiagnostic {
  if (entry.kind === 'uniform-buffer' || entry.kind === 'storage-buffer') {
    const resource = input.resolver.resolveBuffer({
      group: entry.group,
      binding: entry.binding,
      minimumByteSize: entry.minimumByteSize,
      bufferAllocationGeneration: input.bindingKey.parts.bufferAllocationGeneration,
      ringGeneration: input.bindingKey.parts.ringGeneration,
      deviceGeneration: input.bindingKey.parts.deviceGeneration
    });
    if (!isRecord(resource) || !('buffer' in resource) || resource.buffer == null)
      return diagnostic(
        'binding-resource-missing',
        'Material buffer allocation is unavailable.',
        entry.group,
        entry.binding
      );
    const buffer = resource.buffer;
    const resourceIssue = validateResource(buffer, input.resolver.deviceGeneration, entry);
    if (resourceIssue !== undefined) return resourceIssue;
    if (!isRhiBuffer(buffer))
      return diagnostic(
        'binding-resource-kind-mismatch',
        'Material binding expects a buffer RHI resource.',
        entry.group,
        entry.binding
      );
    const offset = resource.offset ?? 0;
    const size = resource.size ?? buffer.size - offset;
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      offset < 0 ||
      size < entry.minimumByteSize ||
      offset + size > buffer.size
    )
      return diagnostic(
        'binding-buffer-range-invalid',
        'Material buffer allocation does not cover the canonical minimum binding size.',
        entry.group,
        entry.binding
      );
    return Object.freeze({
      binding: entry.binding,
      resource: Object.freeze({ buffer, offset, size })
    });
  }
  const facts = resources.get(locationKey(entry));
  if (facts === undefined)
    return diagnostic(
      'binding-resource-missing',
      'Material resource identity is missing from the binding key.',
      entry.group,
      entry.binding
    );
  const resource =
    entry.kind === 'texture'
      ? input.resolver.resolveTextureView(facts)
      : input.resolver.resolveSampler(facts);
  if (resource == null)
    return diagnostic(
      'binding-resource-missing',
      'Material RHI resource is unavailable.',
      entry.group,
      entry.binding
    );
  const resourceIssue = validateResource(resource, input.resolver.deviceGeneration, entry);
  if (resourceIssue !== undefined) return resourceIssue;
  return Object.freeze({ binding: entry.binding, resource });
}

function validateResource(
  resource: unknown,
  deviceGeneration: number,
  entry: CanonicalBindingLayoutEntry
): MaterialBindGroupDiagnostic | undefined {
  if (!isRecord(resource))
    return diagnostic(
      'binding-resource-missing',
      'Material RHI resource handle is missing or malformed.',
      entry.group,
      entry.binding
    );
  const expectedKind =
    entry.kind === 'texture' ? 'texture-view' : entry.kind === 'sampler' ? 'sampler' : 'buffer';
  if (resource.kind !== expectedKind)
    return diagnostic(
      'binding-resource-kind-mismatch',
      `Material binding expects a ${expectedKind} RHI resource.`,
      entry.group,
      entry.binding
    );
  if (resource.generation !== deviceGeneration || resource.state !== 'live')
    return diagnostic(
      'binding-resource-stale',
      'Material RHI resource is stale, disposed, or owned by another device.',
      entry.group,
      entry.binding
    );
  return undefined;
}

function isRhiBuffer(value: unknown): value is RHIResource & {
  readonly kind: 'buffer';
  readonly size: number;
} {
  return isRecord(value) && value.kind === 'buffer' && Number.isSafeInteger(value.size);
}

function locationKey(location: { readonly group: number; readonly binding: number }): string {
  return `${location.group}:${location.binding}`;
}

function diagnostic(
  code: MaterialBindGroupDiagnostic['code'],
  message: string,
  group: number,
  binding: number
): MaterialBindGroupDiagnostic {
  return Object.freeze({ code, message, group, binding });
}

function unsupported(
  diagnosticValue: MaterialBindGroupDiagnostic
): MaterialBindGroupPreparationResult {
  return Object.freeze({ status: 'unsupported', diagnostic: diagnosticValue });
}
