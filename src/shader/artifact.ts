/**
 * @file Cooked runtime artifact decoding and validation functions.
 */

import type {
  CookedShaderBinding,
  CookedShaderEntryPoint,
  CookedShaderModules,
  CookedShaderRuntimeArtifact,
  CookedShaderSourceInfo,
  CookedShaderToolchainInfo,
  ShaderSourceKind
} from './types';

const CANONICAL_URI_PATTERN = /^(?:asset|package):\/\/.+/u;
const VALID_STAGES = new Set(['vertex', 'fragment', 'compute']);

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
  if (!sourceUri || !CANONICAL_URI_PATTERN.test(sourceUri)) {
    throw new Error(
      `Artifact sourceUri must be a canonical URI (asset:// or package://), received: "${sourceUri}"`
    );
  }

  const contentHash = typeof sourceRaw.contentHash === 'string' ? sourceRaw.contentHash.trim() : '';
  if (!contentHash) throw new Error('Artifact source contentHash must be a non-empty string.');

  const byteLength = typeof sourceRaw.byteLength === 'number' ? sourceRaw.byteLength : -1;
  if (byteLength < 0) throw new Error('Artifact source byteLength must be a non-negative number.');

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
    const name = typeof bindingObj.name === 'string' ? bindingObj.name : '';
    const kind = typeof bindingObj.kind === 'string' ? bindingObj.kind : '';
    if (group < 0 || binding < 0) {
      throw new Error(`Invalid group/binding index (${group}, ${binding}).`);
    }
    if (!name) throw new Error('Binding must have a non-empty name.');
    return Object.freeze({
      ...bindingObj,
      group,
      binding,
      name,
      kind
    });
  }

  // Global Bindings
  const rawBindings = Array.isArray(raw.bindings) ? raw.bindings : [];
  const frozenGlobalBindings = Object.freeze(rawBindings.map(decodeBinding));

  // EntryPoints
  if (!Array.isArray(raw.entryPoints) || raw.entryPoints.length === 0) {
    throw new Error('Artifact must have at least one entryPoint.');
  }

  const frozenEntryPoints: CookedShaderEntryPoint[] = [];
  const entryNames = new Set<string>();

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

    const epBindingsRaw = Array.isArray(epObj.bindings) ? epObj.bindings : [];
    const seenBindings = new Set<string>();
    const frozenEpBindings: CookedShaderBinding[] = [];

    for (const b of epBindingsRaw) {
      const decoded = decodeBinding(b);
      const key = `${decoded.group}:${decoded.binding}`;
      if (seenBindings.has(key)) {
        throw new Error(
          `Duplicate binding (group ${decoded.group}, binding ${decoded.binding}) in entry point "${name}".`
        );
      }
      seenBindings.add(key);
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
    if (typeof code === 'string') {
      frozenGlsl[key] = code;
    }
  }

  // Verify that every vertex / fragment entry point has a corresponding GLSL ES 300 module
  for (const ep of frozenEntryPoints) {
    if (ep.stage === 'vertex' || ep.stage === 'fragment') {
      const glslKey = `${ep.stage}:${ep.name}`;
      if (!frozenGlsl[glslKey]) {
        throw new Error(
          `Missing GLSL ES 300 module for entry point "${ep.name}" (key: "${glslKey}").`
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
    bindings: frozenGlobalBindings,
    modules: frozenModules
  });
}
