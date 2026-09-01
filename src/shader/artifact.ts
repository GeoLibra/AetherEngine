/**
 * @file Cooked runtime artifact decoding and validation functions.
 */

import { assertValidCanonicalShaderSourceUri } from './authoring';
import type {
  CookedShaderBinding,
  CookedShaderEntryPoint,
  CookedShaderModules,
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

  if (raw.schemaVersion !== 1) {
    throw new Error(`Invalid schemaVersion ${String(raw.schemaVersion)}. Expected 1.`);
  }
  if (raw.shaderManifestSchemaVersion !== 1) {
    throw new Error(
      `Invalid shaderManifestSchemaVersion ${String(raw.shaderManifestSchemaVersion)}. Expected 1.`
    );
  }
  if (raw.shaderModuleSchemaVersion !== 1) {
    throw new Error(
      `Invalid shaderModuleSchemaVersion ${String(raw.shaderModuleSchemaVersion)}. Expected 1.`
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
      typeof bindingObj.addressSpace === 'string' ? bindingObj.addressSpace : undefined;
    const access = typeof bindingObj.access === 'string' ? bindingObj.access : undefined;
    const typeName = typeof bindingObj.typeName === 'string' ? bindingObj.typeName : undefined;

    return Object.freeze({
      group,
      binding,
      name,
      kind,
      ...(addressSpace !== undefined ? { addressSpace } : {}),
      ...(access !== undefined ? { access } : {}),
      ...(typeName !== undefined ? { typeName } : {})
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

    const epBindingsRaw = Array.isArray(epObj.bindings) ? epObj.bindings : [];
    const seenBindings = new Set<string>();
    const frozenEpBindings: CookedShaderBinding[] = [];

    for (const b of epBindingsRaw) {
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

  const frozenGlsl: Record<string, string> = {};
  for (const [key, code] of Object.entries(glslEs300Raw)) {
    if (typeof code !== 'string' || !code.trim()) {
      throw new Error(
        `[artifact-module-invalid] GLSL ES 300 module for key "${key}" must be a non-empty string.`
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
    frozenGlsl[key] = code;
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
    schemaVersion: 1 as const,
    shaderManifestSchemaVersion: 1 as const,
    shaderModuleSchemaVersion: 1 as const,
    sourceKind,
    toolchain: frozenToolchain,
    source: frozenSource,
    entryPoints: Object.freeze(frozenEntryPoints),
    bindings: Object.freeze(frozenGlobalBindings),
    modules: frozenModules
  });
}
