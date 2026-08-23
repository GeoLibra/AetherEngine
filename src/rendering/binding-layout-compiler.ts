import type { CapabilityPredicate } from '../feature-policy';
import type {
  BufferLayoutManifest,
  ShaderBindingEntryManifest,
  ShaderBindingManifest,
  ShaderStage
} from '../shader';
import { createCanonicalKey } from './pipeline-resolver';
import type {
  BindingLayoutCompileOptions,
  BindingLayoutCompileResult,
  BindingLayoutDiagnostic,
  BindingLayoutId,
  BindingLayoutPlan,
  BindingLocation,
  CanonicalBindingLayoutEntry,
  CanonicalBindGroupLayout
} from './types';

const STAGE_ORDER = Object.freeze(['vertex', 'fragment', 'compute'] as const);

/** Compiles one shader reflection manifest into a canonical portable binding ABI. */
export function compileBindingLayoutPlan(
  manifest: ShaderBindingManifest,
  options: BindingLayoutCompileOptions = {}
): BindingLayoutCompileResult {
  const validation = validateManifest(manifest, options);
  if (validation !== undefined) return invalid(validation);
  const dynamicLocations = new Set(
    (options.dynamicOffsetLocations ?? []).map(({ group, binding }) => `${group}:${binding}`)
  );
  const buffers = new Map(manifest.buffers.map((buffer) => [buffer.name, buffer]));
  const groups = [...manifest.groups]
    .sort((left, right) => left.group - right.group)
    .map((group) => canonicalGroup(group, buffers, dynamicLocations));
  const dynamicOffsetOrder = groups
    .flatMap((group) => group.bindings)
    .filter(
      (entry) =>
        (entry.kind === 'uniform-buffer' || entry.kind === 'storage-buffer') && entry.dynamicOffset
    )
    .map(({ group, binding }) => Object.freeze({ group, binding }));
  const backendRequirements = canonicalRequirements(options.backendRequirements ?? []);
  const facts = Object.freeze({
    shaderAbiVersion: manifest.shaderAbiVersion,
    groups: Object.freeze(groups),
    dynamicOffsetOrder: Object.freeze(dynamicOffsetOrder),
    backendRequirements
  });
  const key = createCanonicalKey(facts);
  const plan: BindingLayoutPlan = Object.freeze({
    id: `binding-layout:${key.hash}:${key.canonicalValue}` as BindingLayoutId,
    ...facts,
    hash: key.hash
  });
  return Object.freeze({ kind: 'success', plan });
}

function validateManifest(
  manifest: ShaderBindingManifest,
  options: BindingLayoutCompileOptions
): BindingLayoutDiagnostic | undefined {
  if (!Array.isArray(options.dynamicOffsetLocations ?? []))
    return diagnostic('invalid-options', 'Dynamic offset locations must be an array.');
  if (!Array.isArray(options.backendRequirements ?? []))
    return diagnostic('invalid-options', 'Backend requirements must be an array.');
  if (!Number.isInteger(manifest.shaderAbiVersion) || manifest.shaderAbiVersion < 0)
    return diagnostic('invalid-manifest', 'Shader ABI version must be a non-negative integer.');
  const groups = new Set<number>();
  const locations = new Map<string, ShaderBindingEntryManifest>();
  const buffers = new Map(manifest.buffers.map((buffer) => [buffer.name, buffer]));
  if (buffers.size !== manifest.buffers.length)
    return diagnostic('invalid-manifest', 'Buffer layout names must be unique.');
  for (const group of manifest.groups) {
    if (!validIndex(group.group))
      return diagnostic('invalid-manifest', 'Invalid binding group.', group.group);
    if (groups.has(group.group))
      return diagnostic('duplicate-group', `Duplicate binding group ${group.group}.`, group.group);
    groups.add(group.group);
    if (!validVisibility(group.visibility))
      return diagnostic(
        'invalid-visibility',
        `Invalid visibility for group ${group.group}.`,
        group.group
      );
    for (const entry of group.entries) {
      const location = `${entry.group}:${entry.binding}`;
      if (entry.group !== group.group || !validIndex(entry.binding))
        return diagnostic(
          'invalid-manifest',
          `Invalid binding location ${location}.`,
          entry.group,
          entry.binding
        );
      if (locations.has(location))
        return diagnostic(
          'duplicate-binding',
          `Duplicate binding at ${location}.`,
          entry.group,
          entry.binding
        );
      locations.set(location, entry);
      if (entry.kind === 'uniform-buffer' || entry.kind === 'storage-buffer') {
        const buffer = buffers.get(entry.bufferLayoutName);
        if (buffer === undefined)
          return diagnostic(
            'missing-buffer-layout',
            `Missing buffer layout ${entry.bufferLayoutName}.`,
            entry.group,
            entry.binding
          );
        const expectedAddressSpace = entry.kind === 'uniform-buffer' ? 'uniform' : 'storage';
        if (buffer.addressSpace !== expectedAddressSpace)
          return diagnostic(
            'invalid-manifest',
            `Binding ${location} and buffer layout address spaces differ.`,
            entry.group,
            entry.binding
          );
      }
    }
  }
  const dynamicLocations = new Set<string>();
  for (const location of options.dynamicOffsetLocations ?? []) {
    if (!validIndex(location?.group) || !validIndex(location?.binding))
      return diagnostic(
        'invalid-options',
        'Dynamic offset locations must contain non-negative integer coordinates.'
      );
    const locationKey = `${location.group}:${location.binding}`;
    if (dynamicLocations.has(locationKey))
      return diagnostic(
        'invalid-options',
        `Duplicate dynamic offset location ${locationKey}.`,
        location.group,
        location.binding
      );
    dynamicLocations.add(locationKey);
    const entry = locations.get(`${location.group}:${location.binding}`);
    if (entry === undefined || (entry.kind !== 'uniform-buffer' && entry.kind !== 'storage-buffer'))
      return diagnostic(
        'invalid-dynamic-offset',
        `Dynamic offset target ${location.group}:${location.binding} is not a buffer binding.`,
        location.group,
        location.binding
      );
  }
  return undefined;
}

function canonicalGroup(
  group: ShaderBindingManifest['groups'][number],
  buffers: ReadonlyMap<string, BufferLayoutManifest>,
  dynamicLocations: ReadonlySet<string>
): CanonicalBindGroupLayout {
  return Object.freeze({
    group: group.group,
    visibility: Object.freeze(STAGE_ORDER.filter((stage) => group.visibility.includes(stage))),
    bindings: Object.freeze(
      [...group.entries]
        .sort((left, right) => left.binding - right.binding)
        .map((entry) => canonicalEntry(entry, buffers, dynamicLocations))
    )
  });
}

function canonicalEntry(
  entry: ShaderBindingEntryManifest,
  buffers: ReadonlyMap<string, BufferLayoutManifest>,
  dynamicLocations: ReadonlySet<string>
): CanonicalBindingLayoutEntry {
  const location = { group: entry.group, binding: entry.binding };
  if (entry.kind === 'texture')
    return Object.freeze({
      ...location,
      kind: entry.kind,
      viewDimension: entry.viewDimension,
      sampleType: entry.sampleType,
      multisampled: entry.multisampled
    });
  if (entry.kind === 'sampler')
    return Object.freeze({ ...location, kind: entry.kind, samplerType: entry.samplerType });
  const buffer = buffers.get(entry.bufferLayoutName)!;
  return Object.freeze({
    ...location,
    kind: entry.kind,
    access: buffer.access,
    minimumByteSize: buffer.byteSize,
    bufferLayoutHash: buffer.layoutHash,
    dynamicOffset: dynamicLocations.has(`${entry.group}:${entry.binding}`)
  });
}

function validVisibility(visibility: readonly ShaderStage[]): boolean {
  return (
    visibility.length > 0 &&
    new Set(visibility).size === visibility.length &&
    visibility.every((stage) => STAGE_ORDER.includes(stage))
  );
}

function canonicalRequirements(
  input: readonly CapabilityPredicate[]
): readonly CapabilityPredicate[] {
  return Object.freeze(
    [...input]
      .map((value) => Object.freeze({ ...value }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  );
}

function validIndex(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}
function diagnostic(
  code: BindingLayoutDiagnostic['code'],
  message: string,
  group?: number,
  binding?: number
): BindingLayoutDiagnostic {
  return Object.freeze({
    code,
    message,
    ...(group === undefined ? {} : { group }),
    ...(binding === undefined ? {} : { binding })
  });
}
function invalid(diagnosticValue: BindingLayoutDiagnostic): BindingLayoutCompileResult {
  return Object.freeze({ kind: 'invalid', diagnostic: diagnosticValue });
}
