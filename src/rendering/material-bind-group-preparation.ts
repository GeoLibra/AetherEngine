import type { GPUBindGroupEntry, RHIResource } from '../rhi/contracts';
import type {
  CanonicalBindingLayoutEntry,
  MaterialBindGroupDiagnostic,
  MaterialBindGroupPreparationInput,
  MaterialBindGroupPreparationResult,
  PreparedMaterialBindGroupDescriptor
} from './types';
import type { BindingResourceKeyParts } from './pipeline-resolver';

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
      dynamicOffsets: Object.freeze([...input.bindingKey.parts.dynamicOffsets])
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
    input.bindingKey.parts.deviceGeneration !== input.resolver.deviceGeneration ||
    input.deviceLayout.pipelineLayout.generation !== input.resolver.deviceGeneration
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
    if (resource === undefined)
      return diagnostic(
        'binding-resource-missing',
        'Material buffer allocation is unavailable.',
        entry.group,
        entry.binding
      );
    const resourceIssue = validateResource(resource.buffer, input.resolver.deviceGeneration, entry);
    if (resourceIssue !== undefined) return resourceIssue;
    const offset = resource.offset ?? 0;
    const size = resource.size ?? resource.buffer.size - offset;
    if (offset < 0 || size < entry.minimumByteSize || offset + size > resource.buffer.size)
      return diagnostic(
        'binding-buffer-range-invalid',
        'Material buffer allocation does not cover the canonical minimum binding size.',
        entry.group,
        entry.binding
      );
    return Object.freeze({ binding: entry.binding, resource: Object.freeze({ ...resource }) });
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
  if (resource === undefined)
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
  resource: RHIResource,
  deviceGeneration: number,
  entry: CanonicalBindingLayoutEntry
): MaterialBindGroupDiagnostic | undefined {
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
