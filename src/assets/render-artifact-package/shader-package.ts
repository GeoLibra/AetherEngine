import { canonicalStringify, isRecord } from '../../core';
import { decodeCookedShaderRuntimeArtifact } from '../../shader/artifact';
import type { CookedShaderRuntimeArtifact } from '../../shader/types';
import { decodeRenderArtifactPackage, encodeRenderArtifactPackage } from './reference-codec';
import type { RenderArtifactPackageSectionInput, RenderArtifactReferenceBundle } from './types';

/** Build identity required to wrap a cooked shader artifact in a render package. */
export interface CookedShaderPackageOptions {
  readonly shaderAbiVersion: number;
  readonly sourceLanguageVersion: string;
  readonly metadataSchemaVersion: number;
  readonly packageToolchain: Readonly<{ id: string; version: string }>;
}

/**
 * Splits one validated cooked shader artifact into a target-addressable reference package.
 *
 * @throws When the artifact, toolchain provenance, or required package metadata is invalid.
 */
export async function encodeCookedShaderArtifactPackage(
  artifact: CookedShaderRuntimeArtifact,
  options: CookedShaderPackageOptions
): Promise<RenderArtifactReferenceBundle> {
  const validated = decodeCookedShaderRuntimeArtifact(artifact);
  const sections: RenderArtifactPackageSectionInput[] = [
    requiredSection('shader-manifest', 'manifest', {
      schemaVersion: validated.schemaVersion,
      shaderManifestSchemaVersion: validated.shaderManifestSchemaVersion,
      shaderModuleSchemaVersion: validated.shaderModuleSchemaVersion,
      sourceKind: validated.sourceKind,
      toolchain: validated.toolchain,
      source: validated.source
    }),
    requiredSection('shader-reflection', 'reflection', {
      entryPoints: validated.entryPoints,
      bindings: validated.bindings,
      vertexInputs: validated.vertexInputs,
      fragmentOutputs: validated.fragmentOutputs
    }),
    requiredSection('shader-layout-plans', 'layout-plans', {
      bufferLayouts: validated.bufferLayouts
    }),
    requiredSection('shader-dependencies', 'dependencies', {
      sources: [validated.source]
    }),
    requiredSection(
      'module:wgsl',
      'shader-module',
      { source: validated.modules.wgsl },
      { shaderTarget: 'wgsl' }
    )
  ];
  for (const [key, source] of Object.entries(validated.modules.glslEs300)) {
    sections.push(
      requiredSection(
        `module:glsl300es:${key}`,
        'shader-module',
        { source },
        {
          shaderTarget: 'glsl300es',
          stage: key.startsWith('vertex:') ? 'vertex' : 'fragment',
          entryPoint: key.slice(key.indexOf(':') + 1)
        }
      )
    );
  }
  return encodeRenderArtifactPackage({
    artifactKind: 'shader-library',
    shaderAbiVersion: options.shaderAbiVersion,
    toolchain: options.packageToolchain,
    shaderToolchain: {
      cookerId: validated.toolchain.cookerId,
      cookerVersion: validated.toolchain.cookerVersion,
      sourceKind: validated.sourceKind,
      sourceLanguageVersion: options.sourceLanguageVersion,
      nagaVersion: validated.toolchain.nagaVersion,
      metadataSchemaVersion: options.metadataSchemaVersion
    },
    sections
  });
}

/**
 * Reconstructs and strictly validates one cooked shader artifact from a reference package.
 *
 * @throws When integrity, section closure, target modules, or shader semantics are invalid.
 */
export async function decodeCookedShaderArtifactPackage(
  bundle: RenderArtifactReferenceBundle
): Promise<CookedShaderRuntimeArtifact> {
  const decoded = await decodeRenderArtifactPackage(bundle);
  if (decoded.envelope.artifactKind !== 'shader-library') {
    throw new Error('[shader-package-kind-invalid] Expected a shader-library package.');
  }
  const manifest = sectionPayload(decoded.sections, 'shader-manifest', 'manifest');
  const reflection = sectionPayload(decoded.sections, 'shader-reflection', 'reflection');
  const layouts = sectionPayload(decoded.sections, 'shader-layout-plans', 'layout-plans');
  const dependencies = sectionPayload(decoded.sections, 'shader-dependencies', 'dependencies');
  const modules = decodeModules(decoded.sections);

  if (
    !Array.isArray(dependencies.sources) ||
    canonicalStringify(dependencies.sources) !== canonicalStringify([manifest.source])
  ) {
    throw new Error(
      '[shader-package-dependencies-invalid] Source dependency closure is inconsistent.'
    );
  }

  return decodeCookedShaderRuntimeArtifact({
    schemaVersion: manifest.schemaVersion,
    shaderManifestSchemaVersion: manifest.shaderManifestSchemaVersion,
    shaderModuleSchemaVersion: manifest.shaderModuleSchemaVersion,
    sourceKind: manifest.sourceKind,
    toolchain: manifest.toolchain,
    source: manifest.source,
    entryPoints: reflection.entryPoints,
    bindings: reflection.bindings,
    bufferLayouts: layouts.bufferLayouts,
    vertexInputs: reflection.vertexInputs,
    fragmentOutputs: reflection.fragmentOutputs,
    modules
  });
}

function requiredSection(
  id: string,
  kind: RenderArtifactPackageSectionInput['kind'],
  payload: unknown,
  target?: RenderArtifactPackageSectionInput['target']
): RenderArtifactPackageSectionInput {
  return { id, kind, required: true, ...(target === undefined ? {} : { target }), payload };
}

function sectionPayload(
  sections: readonly Readonly<RenderArtifactPackageSectionInput>[],
  id: string,
  kind: RenderArtifactPackageSectionInput['kind']
): Readonly<Record<string, unknown>> {
  const matches = sections.filter((section) => section.id === id);
  if (matches.length !== 1 || matches[0]!.kind !== kind || !isRecord(matches[0]!.payload)) {
    throw new Error(`[shader-package-section-invalid] Expected one "${id}" ${kind} section.`);
  }
  return matches[0]!.payload;
}

function decodeModules(
  sections: readonly Readonly<RenderArtifactPackageSectionInput>[]
): Readonly<{ wgsl: string; glslEs300: Readonly<Record<string, string>> }> {
  let wgsl: string | undefined;
  const glslEs300: Record<string, string> = {};
  for (const section of sections.filter(({ kind }) => kind === 'shader-module')) {
    if (!isRecord(section.payload)) {
      throw new Error(`[shader-package-module-invalid] Module section "${section.id}" is invalid.`);
    }
    const source = section.payload.source;
    if (typeof source !== 'string' || !source.trim()) {
      throw new Error(
        `[shader-package-module-invalid] Module section "${section.id}" has no source.`
      );
    }
    if (section.target?.shaderTarget === 'wgsl') {
      if (wgsl !== undefined) {
        throw new Error('[shader-package-module-duplicate] Duplicate WGSL module.');
      }
      wgsl = source;
      continue;
    }
    if (
      section.target?.shaderTarget === 'glsl300es' &&
      section.target.stage !== undefined &&
      section.target.entryPoint !== undefined
    ) {
      const key = `${section.target.stage}:${section.target.entryPoint}`;
      if (Object.hasOwn(glslEs300, key)) {
        throw new Error(`[shader-package-module-duplicate] Duplicate GLSL module "${key}".`);
      }
      glslEs300[key] = source;
      continue;
    }
    throw new Error(
      `[shader-package-module-invalid] Unsupported module target in "${section.id}".`
    );
  }
  return { wgsl: wgsl ?? '', glslEs300 };
}
