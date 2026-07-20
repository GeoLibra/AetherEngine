import { canonicalStringify, stableHash } from './hash';
import { parseFluxShader } from './parser';
import { resolveShaderSource } from './source';
import type { ShaderModuleIR, ShaderSourceRef, ShaderSourceResolver } from './types';

export interface ShaderCookVersions {
  readonly compiler: number;
  readonly ir: number;
  readonly abi: number;
  readonly standardLibrary: number;
}

/**
 * Encapsulates the immutable pre-compiled artifact of a cooked shader asset.
 */
export interface CookedShaderArtifact {
  readonly identity: string;
  readonly fingerprint: string;
  readonly source: ShaderSourceRef;
  readonly dependencies: readonly Readonly<{ uri: string; contentHash: string }>[];
  readonly ir: ShaderModuleIR;
  readonly versions: ShaderCookVersions;
}

/**
 * Pre-compiles a shader's source code into a target-agnostic intermediate representation.
 * Resolves all include files, runs the parser, validates type structures, and outputs
 * a frozen artifact bundled with content hashes of all its file dependencies.
 */
export async function cookShaderArtifact(
  source: ShaderSourceRef,
  resolver: ShaderSourceResolver,
  versions: ShaderCookVersions
): Promise<CookedShaderArtifact> {
  const closure = await resolveShaderSource(source, resolver);
  const parsed = parseFluxShader(closure);
  if (!parsed.ir) {
    throw new Error(
      `Shader cook failed: ${parsed.diagnostics.map((diagnostic) => diagnostic.code).join(', ')}`
    );
  }
  const dependencies = Object.freeze(
    closure.modules.map(({ uri, contentHash }) => Object.freeze({ uri, contentHash }))
  );
  const fingerprint = canonicalStringify({
    closure: closure.hash,
    source: closure.root,
    versions,
    dependencies
  });
  return Object.freeze({
    identity: stableHash(fingerprint),
    fingerprint,
    source: closure.root,
    dependencies,
    ir: parsed.ir,
    versions: Object.freeze({ ...versions })
  });
}
