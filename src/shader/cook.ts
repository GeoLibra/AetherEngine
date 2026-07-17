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

export interface CookedShaderArtifact {
  readonly identity: string;
  readonly fingerprint: string;
  readonly source: ShaderSourceRef;
  readonly dependencies: readonly Readonly<{ uri: string; contentHash: string }>[];
  readonly ir: ShaderModuleIR;
  readonly versions: ShaderCookVersions;
}

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
