import { MaterialDiagnosticError } from '../material/diagnostics';
import { getMaterialSchemaInternals } from '../material/schema';
import type {
  MaterialDiagnostic,
  MaterialDiagnosticCode,
  MaterialField,
  MaterialParameterBlock,
  MaterialSamplerReference,
  MaterialSchema,
  MaterialTextureReference
} from '../material/types';
import type {
  ShaderBindingEntryManifest,
  ShaderBindingManifest,
  ShaderSamplerBindingEntryManifest,
  ShaderTextureBindingEntryManifest
} from '../shader/types';
import type { CanonicalKey } from './pipeline-resolver';
import {
  createMaterialBindingLayoutIdentity,
  type MaterialBindingLayoutIdentityParts
} from './material-binding-identity';

export type MaterialResourceReference = MaterialTextureReference | MaterialSamplerReference;

export type CompiledMaterialTextureBinding = Readonly<{
  kind: 'texture';
  field: MaterialField<MaterialTextureReference>;
  fieldId: string;
  fieldName: string;
  bindingPath: string;
  group: number;
  binding: number;
  viewDimension: '2d' | 'cube';
  sampleType: 'float' | 'depth';
  multisampled: boolean;
}>;

export type CompiledMaterialSamplerBinding = Readonly<{
  kind: 'sampler';
  field: MaterialField<MaterialSamplerReference>;
  fieldId: string;
  fieldName: string;
  bindingPath: string;
  group: number;
  binding: number;
  samplerType: 'filtering' | 'non-filtering' | 'comparison';
}>;

export type CompiledMaterialBinding =
  CompiledMaterialTextureBinding | CompiledMaterialSamplerBinding;

export interface CompiledMaterialBindingLayout {
  readonly schemaId: string;
  readonly schemaVersion: number;
  readonly schemaFingerprint: string;
  readonly shaderLayoutHash: string;
  readonly entries: readonly CompiledMaterialBinding[];
  readonly identity: CanonicalKey<MaterialBindingLayoutIdentityParts>;
}

interface ResolvedMaterialResourceBase {
  readonly id: string;
  readonly payloadVersion: number;
  readonly resourceGeneration: number;
  readonly deviceGeneration: number;
  readonly ready: boolean;
}

export type ResolvedMaterialTextureResource = Readonly<
  ResolvedMaterialResourceBase & {
    kind: 'texture';
    viewDimension: '2d' | 'cube';
    sampleType: 'float' | 'depth';
    multisampled: boolean;
  }
>;

export type ResolvedMaterialSamplerResource = Readonly<
  ResolvedMaterialResourceBase & {
    kind: 'sampler';
    samplerType: 'filtering' | 'non-filtering' | 'comparison';
  }
>;

export type ResolvedMaterialResource =
  ResolvedMaterialTextureResource | ResolvedMaterialSamplerResource;

export interface MaterialResourceResolver {
  readonly deviceGeneration: number;
  resolve(reference: MaterialResourceReference): ResolvedMaterialResource | undefined;
}

export type MaterialBindingResolution =
  | Readonly<{
      status: 'ready';
      resources: readonly ResolvedMaterialResource[];
      diagnostics: readonly MaterialDiagnostic[];
    }>
  | Readonly<{
      status: 'unsupported';
      resources: readonly ResolvedMaterialResource[];
      diagnostics: readonly MaterialDiagnostic[];
    }>;

export function compileMaterialBindingLayout(
  schema: MaterialSchema,
  shaderManifest: ShaderBindingManifest
): CompiledMaterialBindingLayout {
  const shaderEntries = indexShaderEntries(shaderManifest);
  const schemaInternals = getMaterialSchemaInternals(schema);
  const entries = schemaInternals.definitions.flatMap((definition) => {
    if (
      definition.valueType.kind !== 'texture-reference' &&
      definition.valueType.kind !== 'sampler-reference'
    ) {
      return [];
    }
    const candidates = shaderEntries.get(definition.bindingPath) ?? [];
    if (candidates.length === 0) {
      throw compileError(
        schema,
        'missing-binding',
        definition.name,
        `Material binding path "${definition.bindingPath}" is missing from Shader reflection.`
      );
    }
    if (candidates.length > 1) {
      throw compileError(
        schema,
        'compile-failure',
        definition.name,
        `Material binding path "${definition.bindingPath}" is ambiguous in Shader reflection.`
      );
    }
    const shaderEntry = candidates[0]!;
    const expectedKind = definition.valueType.kind === 'texture-reference' ? 'texture' : 'sampler';
    if (shaderEntry.kind !== expectedKind) {
      throw compileError(
        schema,
        'binding-kind-mismatch',
        definition.name,
        `Material field "${definition.name}" expects a ${expectedKind} binding.`
      );
    }
    const field = schemaInternals.fieldsById.get(definition.fieldId);
    if (field === undefined) throw new Error('Material schema field token is missing.');
    return [compileBinding(field, definition.bindingPath, shaderEntry)];
  });
  const layout = {
    schemaId: schema.id,
    schemaVersion: schema.version,
    schemaFingerprint: schema.fingerprint,
    shaderLayoutHash: shaderManifest.layoutHash,
    entries: Object.freeze(entries)
  };
  return Object.freeze({
    ...layout,
    identity: createMaterialBindingLayoutIdentity(layout)
  });
}

export function resolveMaterialBindings(
  layout: CompiledMaterialBindingLayout,
  supplied: MaterialParameterBlock,
  defaults: MaterialParameterBlock | undefined,
  resolver: MaterialResourceResolver
): MaterialBindingResolution {
  const resources: ResolvedMaterialResource[] = [];
  const diagnostics: MaterialDiagnostic[] = [];
  for (const entry of layout.entries) {
    const suppliedReference =
      entry.kind === 'texture' ? supplied.get(entry.field) : supplied.get(entry.field);
    const suppliedResource = resolver.resolve(suppliedReference);
    const suppliedIssue = availabilityDiagnostic(layout, entry, suppliedResource);
    if (suppliedIssue === undefined) {
      const compatibilityIssue = compatibilityDiagnostic(
        layout,
        entry,
        suppliedReference,
        suppliedResource!,
        resolver.deviceGeneration
      );
      if (compatibilityIssue === undefined) resources.push(snapshotResource(suppliedResource!));
      else diagnostics.push(compatibilityIssue);
      continue;
    }
    diagnostics.push(suppliedIssue);
    const defaultReference =
      defaults === undefined
        ? undefined
        : entry.kind === 'texture'
          ? defaults.get(entry.field)
          : defaults.get(entry.field);
    if (defaultReference === undefined) {
      diagnostics.push(
        diagnostic(layout, entry, 'missing-resource', 'Material binding has no schema default.')
      );
      continue;
    }
    const defaultResource = resolver.resolve(defaultReference);
    const defaultAvailabilityIssue = availabilityDiagnostic(layout, entry, defaultResource);
    if (defaultAvailabilityIssue !== undefined) {
      diagnostics.push(defaultAvailabilityIssue);
      continue;
    }
    const defaultCompatibilityIssue = compatibilityDiagnostic(
      layout,
      entry,
      defaultReference,
      defaultResource!,
      resolver.deviceGeneration
    );
    if (defaultCompatibilityIssue === undefined) resources.push(snapshotResource(defaultResource!));
    else diagnostics.push(defaultCompatibilityIssue);
  }
  const frozenResources = Object.freeze(resources);
  const frozenDiagnostics = Object.freeze(diagnostics);
  return Object.freeze({
    status: resources.length === layout.entries.length ? 'ready' : 'unsupported',
    resources: frozenResources,
    diagnostics: frozenDiagnostics
  }) as MaterialBindingResolution;
}

function indexShaderEntries(
  manifest: ShaderBindingManifest
): ReadonlyMap<string, readonly ShaderBindingEntryManifest[]> {
  const indexed = new Map<string, ShaderBindingEntryManifest[]>();
  for (const group of manifest.groups) {
    for (const entry of group.entries) {
      const candidates = indexed.get(entry.name) ?? [];
      candidates.push(entry);
      indexed.set(entry.name, candidates);
    }
  }
  return indexed;
}

function compileBinding(
  field: MaterialField,
  bindingPath: string,
  entry: ShaderTextureBindingEntryManifest | ShaderSamplerBindingEntryManifest
): CompiledMaterialBinding {
  const common = {
    fieldId: field.fieldId,
    fieldName: field.name,
    bindingPath,
    group: entry.group,
    binding: entry.binding
  };
  return entry.kind === 'texture'
    ? Object.freeze({
        kind: entry.kind,
        field: field as MaterialField<MaterialTextureReference>,
        ...common,
        viewDimension: entry.viewDimension,
        sampleType: entry.sampleType,
        multisampled: entry.multisampled
      })
    : Object.freeze({
        kind: entry.kind,
        field: field as MaterialField<MaterialSamplerReference>,
        ...common,
        samplerType: entry.samplerType
      });
}

function availabilityDiagnostic(
  layout: CompiledMaterialBindingLayout,
  entry: CompiledMaterialBinding,
  resource: ResolvedMaterialResource | undefined
): MaterialDiagnostic | undefined {
  if (resource === undefined) {
    return diagnostic(
      layout,
      entry,
      'missing-resource',
      'Material resource could not be resolved.'
    );
  }
  if (!resource.ready) {
    return diagnostic(layout, entry, 'resource-not-ready', 'Material resource is not ready.');
  }
  return undefined;
}

function compatibilityDiagnostic(
  layout: CompiledMaterialBindingLayout,
  entry: CompiledMaterialBinding,
  reference: MaterialResourceReference,
  resource: ResolvedMaterialResource,
  deviceGeneration: number
): MaterialDiagnostic | undefined {
  if (resource.id !== reference.assetId) {
    return diagnostic(
      layout,
      entry,
      'missing-resource',
      'Resolved material resource identity mismatches the requested asset.'
    );
  }
  if (entry.kind !== resource.kind) {
    return diagnostic(layout, entry, 'binding-kind-mismatch', 'Material resource kind mismatches.');
  }
  if (entry.kind === 'texture' && resource.kind === 'texture') {
    if (entry.viewDimension !== resource.viewDimension) {
      return diagnostic(
        layout,
        entry,
        'texture-dimension-mismatch',
        'Texture view dimension mismatches.'
      );
    }
    if (entry.sampleType !== resource.sampleType) {
      return diagnostic(
        layout,
        entry,
        'texture-sample-type-mismatch',
        'Texture sample type mismatches.'
      );
    }
    if (entry.multisampled !== resource.multisampled) {
      return diagnostic(
        layout,
        entry,
        'texture-multisample-mismatch',
        'Texture multisampling mismatches.'
      );
    }
  }
  if (entry.kind === 'sampler' && resource.kind === 'sampler') {
    if (entry.samplerType !== resource.samplerType) {
      return diagnostic(layout, entry, 'sampler-type-mismatch', 'Sampler type mismatches.');
    }
  }
  if (resource.deviceGeneration !== deviceGeneration) {
    return diagnostic(
      layout,
      entry,
      'device-generation-mismatch',
      'Material resource belongs to another device generation.'
    );
  }
  return undefined;
}

function snapshotResource(resource: ResolvedMaterialResource): ResolvedMaterialResource {
  const common = {
    id: resource.id,
    payloadVersion: resource.payloadVersion,
    resourceGeneration: resource.resourceGeneration,
    deviceGeneration: resource.deviceGeneration,
    ready: resource.ready
  };
  return resource.kind === 'texture'
    ? Object.freeze({
        kind: resource.kind,
        ...common,
        viewDimension: resource.viewDimension,
        sampleType: resource.sampleType,
        multisampled: resource.multisampled
      })
    : Object.freeze({
        kind: resource.kind,
        ...common,
        samplerType: resource.samplerType
      });
}

function diagnostic(
  layout: CompiledMaterialBindingLayout,
  entry: CompiledMaterialBinding,
  code: MaterialDiagnosticCode,
  message: string
): MaterialDiagnostic {
  return Object.freeze({
    code,
    schemaId: layout.schemaId,
    schemaVersion: layout.schemaVersion,
    field: entry.fieldName,
    message
  });
}

function compileError(
  schema: MaterialSchema,
  code: 'missing-binding' | 'compile-failure' | 'binding-kind-mismatch',
  field: string,
  message: string
): MaterialDiagnosticError {
  return new MaterialDiagnosticError({
    code,
    schemaId: schema.id,
    schemaVersion: schema.version,
    field,
    message
  });
}
