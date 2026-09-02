/**
 * @file Cooked runtime artifact decoding and validation functions.
 */

import { assertValidCanonicalShaderSourceUri } from './authoring';
import type {
  CookedShaderBinding,
  CookedShaderBindingReference,
  CookedShaderBufferField,
  CookedShaderBufferLayout,
  CookedShaderStageIo,
  CookedShaderEntryPoint,
  CookedShaderModules,
  CookedGlslEs300Module,
  CookedGlslProgramBinding,
  CookedShaderRuntimeArtifact,
  CookedShaderSourceInfo,
  CookedShaderToolchainInfo,
  ShaderBindingKind,
  ShaderSourceKind
} from './types';

const VALID_STAGES = new Set(['vertex', 'fragment', 'compute']);

const VALID_BINDING_KINDS = new Set<ShaderBindingKind>([
  'uniform-buffer',
  'storage-buffer',
  'texture',
  'sampler',
  'storage-texture',
  'comparison-sampler'
]);

const HASH_64_HEX_PATTERN = /^[0-9a-f]{64}$/u;
const GLSL_KEY_PATTERN = /^(vertex|fragment):[a-zA-Z0-9_]+$/u;

function bindingsAreEqual(a: CookedShaderBinding, b: CookedShaderBinding): boolean {
  return (
    a.group === b.group &&
    a.binding === b.binding &&
    a.name === b.name &&
    a.kind === b.kind &&
    a.addressSpace === b.addressSpace &&
    a.access === b.access &&
    a.typeName === b.typeName
  );
}

/**
 * Decodes and validates untrusted cooker output into an immutable CookedShaderRuntimeArtifact.
 *
 * @param value Untrusted JSON value.
 * @returns Frozen, validated CookedShaderRuntimeArtifact snapshot.
 * @throws {Error} On missing toolchain info, invalid schemas, non-canonical URIs, duplicate bindings, or missing backend modules.
 */
export function decodeCookedShaderRuntimeArtifact(value: unknown): CookedShaderRuntimeArtifact {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Cooked shader runtime artifact must be a non-null object.');
  }

  const raw = value as Record<string, unknown>;

  if (raw.schemaVersion !== 2) {
    throw new Error(`Invalid schemaVersion ${String(raw.schemaVersion)}. Expected 2.`);
  }
  if (raw.shaderManifestSchemaVersion !== 1) {
    throw new Error(
      `Invalid shaderManifestSchemaVersion ${String(raw.shaderManifestSchemaVersion)}. Expected 1.`
    );
  }
  if (raw.shaderModuleSchemaVersion !== 2) {
    throw new Error(
      `Invalid shaderModuleSchemaVersion ${String(raw.shaderModuleSchemaVersion)}. Expected 2.`
    );
  }

  const sourceKind = (raw.sourceKind ?? 'wgsl') as ShaderSourceKind;
  const validKinds: readonly ShaderSourceKind[] = Object.freeze([
    'wgsl',
    'flux-experimental',
    'shader-graph'
  ]);
  if (!validKinds.includes(sourceKind)) {
    throw new Error(`Invalid sourceKind "${String(raw.sourceKind)}".`);
  }

  // Toolchain
  if (!raw.toolchain || typeof raw.toolchain !== 'object') {
    throw new Error('Artifact must specify toolchain info.');
  }
  const toolchainRaw = raw.toolchain as Record<string, unknown>;
  const cookerId = typeof toolchainRaw.cookerId === 'string' ? toolchainRaw.cookerId.trim() : '';
  const cookerVersion =
    typeof toolchainRaw.cookerVersion === 'string' ? toolchainRaw.cookerVersion.trim() : '';
  const nagaVersion =
    typeof toolchainRaw.nagaVersion === 'string' ? toolchainRaw.nagaVersion.trim() : '';

  if (!cookerId) throw new Error('Artifact toolchain cookerId must be a non-empty string.');
  if (!cookerVersion)
    throw new Error('Artifact toolchain cookerVersion must be a non-empty string.');
  if (!nagaVersion) throw new Error('Artifact toolchain nagaVersion must be a non-empty string.');

  const frozenToolchain: CookedShaderToolchainInfo = Object.freeze({
    cookerId,
    cookerVersion,
    nagaVersion
  });

  // Source
  if (!raw.source || typeof raw.source !== 'object') {
    throw new Error('Artifact must specify source info.');
  }
  const sourceRaw = raw.source as Record<string, unknown>;
  const sourceUri = typeof sourceRaw.sourceUri === 'string' ? sourceRaw.sourceUri.trim() : '';
  assertValidCanonicalShaderSourceUri(sourceUri);

  const contentHash = typeof sourceRaw.contentHash === 'string' ? sourceRaw.contentHash.trim() : '';
  if (!HASH_64_HEX_PATTERN.test(contentHash)) {
    throw new Error(
      `Artifact source contentHash must be a 64-character lowercase hexadecimal hash, received: "${contentHash}".`
    );
  }

  const byteLength = typeof sourceRaw.byteLength === 'number' ? sourceRaw.byteLength : -1;
  if (!Number.isInteger(byteLength) || byteLength < 0) {
    throw new Error('Artifact source byteLength must be a non-negative integer.');
  }

  const frozenSource: CookedShaderSourceInfo = Object.freeze({
    sourceUri,
    contentHash,
    byteLength
  });

  // Bindings helper
  function decodeBinding(b: unknown): CookedShaderBinding {
    if (!b || typeof b !== 'object') throw new Error('Binding entry must be an object.');
    const bindingObj = b as Record<string, unknown>;
    const group = typeof bindingObj.group === 'number' ? bindingObj.group : -1;
    const binding = typeof bindingObj.binding === 'number' ? bindingObj.binding : -1;
    const name = typeof bindingObj.name === 'string' ? bindingObj.name.trim() : '';
    const kindRaw = typeof bindingObj.kind === 'string' ? bindingObj.kind : '';

    if (!Number.isInteger(group) || group < 0 || !Number.isInteger(binding) || binding < 0) {
      throw new Error(
        `[artifact-binding-invalid] Invalid group/binding index (${group}, ${binding}).`
      );
    }
    if (!name) {
      throw new Error('[artifact-binding-invalid] Binding must have a non-empty name.');
    }
    if (!VALID_BINDING_KINDS.has(kindRaw as ShaderBindingKind)) {
      throw new Error(`[artifact-binding-invalid] Unsupported binding kind "${kindRaw}".`);
    }
    const kind = kindRaw as ShaderBindingKind;

    const addressSpace =
      typeof bindingObj.addressSpace === 'string' ? bindingObj.addressSpace.trim() : '';
    const access = typeof bindingObj.access === 'string' ? bindingObj.access.trim() : '';
    const typeName = typeof bindingObj.typeName === 'string' ? bindingObj.typeName.trim() : '';

    if (!addressSpace) {
      throw new Error(
        '[artifact-binding-invalid] Binding addressSpace must be a non-empty string.'
      );
    }
    if (!access) {
      throw new Error('[artifact-binding-invalid] Binding access must be a non-empty string.');
    }
    if (!typeName) {
      throw new Error('[artifact-binding-invalid] Binding typeName must be a non-empty string.');
    }

    return Object.freeze({
      group,
      binding,
      name,
      kind,
      addressSpace,
      access,
      typeName
    });
  }

  // Global Bindings
  if (!Array.isArray(raw.bindings)) {
    throw new Error('Artifact must specify a bindings array.');
  }

  const globalBindingMap = new Map<string, CookedShaderBinding>();
  const globalBindingNames = new Set<string>();
  const frozenGlobalBindings: CookedShaderBinding[] = [];

  for (const b of raw.bindings) {
    const decoded = decodeBinding(b);
    const key = `${decoded.group}:${decoded.binding}`;
    if (globalBindingMap.has(key)) {
      throw new Error(
        `[artifact-binding-invalid] Duplicate global binding for (group ${decoded.group}, binding ${decoded.binding}).`
      );
    }
    if (globalBindingNames.has(decoded.name)) {
      throw new Error(
        `[artifact-binding-invalid] Duplicate global binding name "${decoded.name}".`
      );
    }
    globalBindingMap.set(key, decoded);
    globalBindingNames.add(decoded.name);
    frozenGlobalBindings.push(decoded);
  }

  if (!Array.isArray(raw.bufferLayouts)) {
    throw new Error('[artifact-layout-invalid] Artifact bufferLayouts must be an array.');
  }
  const frozenBufferLayouts: CookedShaderBufferLayout[] = [];
  const seenBufferLayouts = new Set<string>();
  for (const value of raw.bufferLayouts) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('[artifact-layout-invalid] Buffer layout must be an object.');
    }
    const layout = value as Record<string, unknown>;
    const group = typeof layout.group === 'number' ? layout.group : -1;
    const binding = typeof layout.binding === 'number' ? layout.binding : -1;
    const name = typeof layout.name === 'string' ? layout.name.trim() : '';
    const byteSize = typeof layout.byteSize === 'number' ? layout.byteSize : -1;
    const alignment = typeof layout.alignment === 'number' ? layout.alignment : -1;
    if (!Number.isInteger(group) || group < 0 || !Number.isInteger(binding) || binding < 0) {
      throw new Error(
        '[artifact-layout-invalid] Buffer layout group/binding must be non-negative integers.'
      );
    }
    if (!name || !Number.isInteger(byteSize) || byteSize <= 0 || !isPowerOfTwo(alignment)) {
      throw new Error(
        '[artifact-layout-invalid] Buffer layout name, byteSize, or alignment is invalid.'
      );
    }
    const key = `${group}:${binding}`;
    if (seenBufferLayouts.has(key)) {
      throw new Error(`[artifact-layout-invalid] Duplicate buffer layout for (${key}).`);
    }
    const reflectedBinding = globalBindingMap.get(key);
    if (
      !reflectedBinding ||
      reflectedBinding.name !== name ||
      (reflectedBinding.kind !== 'uniform-buffer' && reflectedBinding.kind !== 'storage-buffer')
    ) {
      throw new Error(
        `[artifact-layout-invalid] Buffer layout "${name}" does not match a reflected buffer binding.`
      );
    }
    if (!Array.isArray(layout.fields) || layout.fields.length === 0) {
      throw new Error(
        `[artifact-layout-invalid] Buffer layout "${name}" fields must be a non-empty array.`
      );
    }
    const fields: CookedShaderBufferField[] = [];
    const seenPaths = new Set<string>();
    for (const fieldValue of layout.fields) {
      if (!fieldValue || typeof fieldValue !== 'object' || Array.isArray(fieldValue)) {
        throw new Error('[artifact-layout-invalid] Buffer field must be an object.');
      }
      const field = fieldValue as Record<string, unknown>;
      const path = typeof field.path === 'string' ? field.path.trim() : '';
      const offset = typeof field.offset === 'number' ? field.offset : -1;
      const size = typeof field.size === 'number' ? field.size : -1;
      const fieldAlignment = typeof field.alignment === 'number' ? field.alignment : -1;
      const typeName = typeof field.typeName === 'string' ? field.typeName.trim() : '';
      if (
        !path ||
        seenPaths.has(path) ||
        !Number.isInteger(offset) ||
        offset < 0 ||
        !Number.isInteger(size) ||
        size <= 0 ||
        offset + size > byteSize ||
        !isPowerOfTwo(fieldAlignment) ||
        offset % fieldAlignment !== 0 ||
        !typeName
      ) {
        throw new Error(
          `[artifact-layout-invalid] Invalid buffer field "${path}" in layout "${name}".`
        );
      }
      seenPaths.add(path);
      fields.push(Object.freeze({ path, offset, size, alignment: fieldAlignment, typeName }));
    }
    seenBufferLayouts.add(key);
    frozenBufferLayouts.push(
      Object.freeze({
        group,
        binding,
        name,
        byteSize,
        alignment,
        fields: Object.freeze(fields)
      })
    );
  }

  for (const binding of frozenGlobalBindings) {
    if (
      (binding.kind === 'uniform-buffer' || binding.kind === 'storage-buffer') &&
      !seenBufferLayouts.has(`${binding.group}:${binding.binding}`)
    ) {
      throw new Error(
        `[artifact-layout-invalid] Missing buffer layout for binding "${binding.name}".`
      );
    }
  }

  const decodeStageIo = (value: unknown, label: string): readonly CookedShaderStageIo[] => {
    if (!Array.isArray(value)) {
      throw new Error(`[artifact-stage-io-invalid] Artifact ${label} must be an array.`);
    }
    const seenLocations = new Set<number>();
    return Object.freeze(
      value.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw new Error(`[artifact-stage-io-invalid] ${label} entry must be an object.`);
        }
        const rawIo = item as Record<string, unknown>;
        const location = typeof rawIo.location === 'number' ? rawIo.location : -1;
        const name = typeof rawIo.name === 'string' ? rawIo.name.trim() : '';
        const typeName = typeof rawIo.typeName === 'string' ? rawIo.typeName.trim() : '';
        if (
          !Number.isInteger(location) ||
          location < 0 ||
          seenLocations.has(location) ||
          !name ||
          !typeName
        ) {
          throw new Error(
            `[artifact-stage-io-invalid] Invalid ${label} entry at location ${location}.`
          );
        }
        seenLocations.add(location);
        return Object.freeze({ location, name, typeName });
      })
    );
  };
  const frozenVertexInputs = decodeStageIo(raw.vertexInputs, 'vertexInputs');
  const frozenFragmentOutputs = decodeStageIo(raw.fragmentOutputs, 'fragmentOutputs');

  // EntryPoints
  if (!Array.isArray(raw.entryPoints) || raw.entryPoints.length === 0) {
    throw new Error('Artifact must have at least one entryPoint.');
  }

  const frozenEntryPoints: CookedShaderEntryPoint[] = [];
  const entryNames = new Set<string>();
  const declaredEntryPointsMap = new Map<string, 'vertex' | 'fragment' | 'compute'>();

  for (const ep of raw.entryPoints) {
    if (!ep || typeof ep !== 'object') throw new Error('EntryPoint must be an object.');
    const epObj = ep as Record<string, unknown>;
    const name = typeof epObj.name === 'string' ? epObj.name.trim() : '';
    const stage = typeof epObj.stage === 'string' ? epObj.stage.trim() : '';
    if (!name) throw new Error('EntryPoint name must be a non-empty string.');
    if (entryNames.has(name)) throw new Error(`Duplicate entryPoint "${name}".`);
    entryNames.add(name);

    if (!VALID_STAGES.has(stage)) {
      throw new Error(`Invalid stage "${stage}" in entryPoint "${name}".`);
    }

    declaredEntryPointsMap.set(name, stage as 'vertex' | 'fragment' | 'compute');

    if (!Array.isArray(epObj.bindings)) {
      throw new Error(
        `[artifact-binding-invalid] Entry point "${name}" bindings must be an array.`
      );
    }

    const seenBindings = new Set<string>();
    const frozenEpBindings: CookedShaderBinding[] = [];

    for (const b of epObj.bindings) {
      const decoded = decodeBinding(b);
      const key = `${decoded.group}:${decoded.binding}`;
      if (seenBindings.has(key)) {
        throw new Error(
          `[artifact-binding-invalid] Duplicate binding (group ${decoded.group}, binding ${decoded.binding}) in entry point "${name}".`
        );
      }
      seenBindings.add(key);

      const matchingGlobal = globalBindingMap.get(key);
      if (!matchingGlobal) {
        throw new Error(
          `[artifact-binding-invalid] Entry point "${name}" references binding (group ${decoded.group}, binding ${decoded.binding}) which is not declared in global bindings.`
        );
      }
      if (!bindingsAreEqual(decoded, matchingGlobal)) {
        throw new Error(
          `[artifact-binding-invalid] Entry point "${name}" binding (group ${decoded.group}, binding ${decoded.binding}) does not match corresponding global binding.`
        );
      }

      frozenEpBindings.push(decoded);
    }

    frozenEntryPoints.push(
      Object.freeze({
        name,
        stage: stage as 'vertex' | 'fragment' | 'compute',
        bindings: Object.freeze(frozenEpBindings)
      })
    );
  }

  // Modules
  if (!raw.modules || typeof raw.modules !== 'object') {
    throw new Error('Artifact must specify modules.');
  }
  const modulesRaw = raw.modules as Record<string, unknown>;
  const wgsl = typeof modulesRaw.wgsl === 'string' ? modulesRaw.wgsl : '';
  if (!wgsl.trim()) {
    throw new Error('Artifact modules.wgsl must be a non-empty string.');
  }

  const glslEs300Raw =
    modulesRaw.glslEs300 && typeof modulesRaw.glslEs300 === 'object'
      ? (modulesRaw.glslEs300 as Record<string, unknown>)
      : {};

  const frozenGlsl: Record<string, CookedGlslEs300Module> = {};
  for (const [key, moduleValue] of Object.entries(glslEs300Raw)) {
    if (!moduleValue || typeof moduleValue !== 'object' || Array.isArray(moduleValue)) {
      throw new Error(
        `[artifact-module-invalid] GLSL ES 300 module for key "${key}" must be an object.`
      );
    }
    if (!GLSL_KEY_PATTERN.test(key)) {
      throw new Error(
        `[artifact-module-invalid] Invalid GLSL ES 300 module key format "${key}". Expected stage:entryName.`
      );
    }
    const [keyStage, keyEntry] = key.split(':');
    const declaredStage = declaredEntryPointsMap.get(keyEntry!);
    if (!declaredStage || declaredStage !== keyStage) {
      throw new Error(
        `[artifact-module-invalid] Unexpected GLSL ES 300 module key "${key}" does not match declared entry point "${keyEntry}".`
      );
    }
    const moduleRaw = moduleValue as Record<string, unknown>;
    const source = typeof moduleRaw.source === 'string' ? moduleRaw.source : '';
    if (!source.trim()) {
      throw new Error(
        `[artifact-module-invalid] GLSL ES 300 module source for key "${key}" must be non-empty.`
      );
    }
    const entryPoint = frozenEntryPoints.find(
      (entry) => entry.name === keyEntry && entry.stage === keyStage
    );
    if (!entryPoint) {
      throw new Error(`[artifact-module-invalid] Missing entry point for GLSL module "${key}".`);
    }
    if (!Array.isArray(moduleRaw.bindings)) {
      throw new Error(`[artifact-module-invalid] GLSL module "${key}" bindings must be an array.`);
    }
    const programBindings = decodeGlslProgramBindings(moduleRaw.bindings, entryPoint.bindings, key);
    frozenGlsl[key] = Object.freeze({ source, bindings: programBindings });
  }

  // Verify that every vertex / fragment entry point has a corresponding GLSL ES 300 module
  for (const ep of frozenEntryPoints) {
    if (ep.stage === 'vertex' || ep.stage === 'fragment') {
      const glslKey = `${ep.stage}:${ep.name}`;
      if (!frozenGlsl[glslKey]) {
        throw new Error(
          `[artifact-module-missing] Missing GLSL ES 300 module for entry point "${ep.name}" (key: "${glslKey}").`
        );
      }
    }
  }

  const frozenModules: CookedShaderModules = Object.freeze({
    wgsl,
    glslEs300: Object.freeze(frozenGlsl)
  });

  return Object.freeze({
    schemaVersion: 2 as const,
    shaderManifestSchemaVersion: 1 as const,
    shaderModuleSchemaVersion: 2 as const,
    sourceKind,
    toolchain: frozenToolchain,
    source: frozenSource,
    entryPoints: Object.freeze(frozenEntryPoints),
    bindings: Object.freeze(frozenGlobalBindings),
    bufferLayouts: Object.freeze(frozenBufferLayouts),
    vertexInputs: frozenVertexInputs,
    fragmentOutputs: frozenFragmentOutputs,
    modules: frozenModules
  });
}

function decodeGlslProgramBindings(
  values: readonly unknown[],
  activeBindings: readonly CookedShaderBinding[],
  moduleKey: string
): readonly CookedGlslProgramBinding[] {
  const activeByCoordinate = new Map(
    activeBindings.map((binding) => [`${binding.group}:${binding.binding}`, binding])
  );
  const generatedNames = new Set<string>();
  const mappedCoordinates = new Set<string>();
  const decoded = values.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(
        `[artifact-module-binding-invalid] Binding in "${moduleKey}" must be an object.`
      );
    }
    const raw = value as Record<string, unknown>;
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name || generatedNames.has(name)) {
      throw new Error(
        `[artifact-module-binding-invalid] GLSL module "${moduleKey}" has an empty or duplicate generated binding name.`
      );
    }
    generatedNames.add(name);
    if (raw.kind === 'uniform-buffer') {
      const resource = decodeBindingReference(raw.resource, moduleKey);
      const canonical = activeByCoordinate.get(bindingReferenceKey(resource));
      if (canonical?.kind !== 'uniform-buffer') {
        throw new Error(
          `[artifact-module-binding-invalid] Uniform block "${name}" does not reference an active canonical uniform buffer.`
        );
      }
      mappedCoordinates.add(bindingReferenceKey(resource));
      return Object.freeze({ kind: 'uniform-buffer' as const, name, resource });
    }
    if (raw.kind === 'combined-sampler') {
      const texture = decodeBindingReference(raw.texture, moduleKey);
      const canonicalTexture = activeByCoordinate.get(bindingReferenceKey(texture));
      if (canonicalTexture?.kind !== 'texture') {
        throw new Error(
          `[artifact-module-binding-invalid] Combined sampler "${name}" does not reference an active canonical texture.`
        );
      }
      mappedCoordinates.add(bindingReferenceKey(texture));
      const sampler =
        raw.sampler === undefined || raw.sampler === null
          ? undefined
          : decodeBindingReference(raw.sampler, moduleKey);
      if (sampler) {
        const canonicalSampler = activeByCoordinate.get(bindingReferenceKey(sampler));
        if (
          canonicalSampler?.kind !== 'sampler' &&
          canonicalSampler?.kind !== 'comparison-sampler'
        ) {
          throw new Error(
            `[artifact-module-binding-invalid] Combined sampler "${name}" does not reference an active canonical sampler.`
          );
        }
        mappedCoordinates.add(bindingReferenceKey(sampler));
      }
      return Object.freeze({
        kind: 'combined-sampler' as const,
        name,
        texture,
        ...(sampler === undefined ? {} : { sampler })
      });
    }
    throw new Error(
      `[artifact-module-binding-invalid] Unsupported GLSL program binding kind "${String(raw.kind)}".`
    );
  });
  for (const binding of activeBindings) {
    if (
      (binding.kind === 'uniform-buffer' ||
        binding.kind === 'texture' ||
        binding.kind === 'sampler' ||
        binding.kind === 'comparison-sampler') &&
      !mappedCoordinates.has(`${binding.group}:${binding.binding}`)
    ) {
      throw new Error(
        `[artifact-module-binding-invalid] GLSL module "${moduleKey}" is missing backend metadata for active binding "${binding.name}".`
      );
    }
  }
  return Object.freeze(decoded);
}

function decodeBindingReference(value: unknown, moduleKey: string): CookedShaderBindingReference {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(
      `[artifact-module-binding-invalid] GLSL module "${moduleKey}" binding reference must be an object.`
    );
  }
  const raw = value as Record<string, unknown>;
  const group = typeof raw.group === 'number' ? raw.group : -1;
  const binding = typeof raw.binding === 'number' ? raw.binding : -1;
  if (!Number.isInteger(group) || group < 0 || !Number.isInteger(binding) || binding < 0) {
    throw new Error(
      `[artifact-module-binding-invalid] GLSL module "${moduleKey}" binding reference must use non-negative integer coordinates.`
    );
  }
  return Object.freeze({ group, binding });
}

function bindingReferenceKey(reference: CookedShaderBindingReference): string {
  return `${reference.group}:${reference.binding}`;
}

function isPowerOfTwo(value: number): boolean {
  return Number.isInteger(value) && value > 0 && (value & (value - 1)) === 0;
}
