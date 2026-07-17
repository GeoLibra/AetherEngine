import { emitShaderBackend, type ShaderBackendValidator } from './backend';
import { ShaderArtifactCache } from './cache';
import { canonicalStringify, stableHash } from './hash';
import { parseFluxShader } from './parser';
import { createShaderBindingManifest } from './layout';
import { resolveShaderSource } from './source';
import { resolveShaderVariants } from './variant';
import type { WebGL2ShaderTranslationPort } from '../rhi/webgl2/shader-types';
import type {
  ShaderBindingManifest,
  ShaderCompileRequest,
  ShaderDiagnostic,
  ShaderSourceResolver,
  ShaderTarget
} from './types';

export interface CompiledShaderArtifact {
  readonly key: string;
  readonly fingerprint: string;
  readonly source: string;
  readonly target: ShaderTarget;
  readonly sourceUri: string;
  readonly variantKey: string;
  readonly manifest: ShaderBindingManifest;
}
export type ShaderCompileResult =
  | Readonly<{
      status: 'compiled' | 'cached';
      revision: number;
      key: string;
      artifact: CompiledShaderArtifact;
      diagnostics: readonly ShaderDiagnostic[];
    }>
  | Readonly<{
      status: 'failed' | 'cancelled';
      revision: number;
      key?: string;
      diagnostics: readonly ShaderDiagnostic[];
    }>;

export class ShaderCompiler {
  private readonly cache = new ShaderArtifactCache<CompiledShaderArtifact>({ maxEntries: 64 });
  private readonly latestRevision = new Map<string, number>();
  private readonly good = new Map<string, CompiledShaderArtifact>();
  constructor(
    private readonly options: Readonly<{
      resolver: ShaderSourceResolver;
      validators: Partial<Record<ShaderTarget, ShaderBackendValidator>>;
      webgl2Translator?: WebGL2ShaderTranslationPort;
      approvedWebGL2Extensions?: readonly string[];
      versions: Readonly<{ compiler: number; ir: number; abi: number; backend: number }>;
    }>
  ) {}
  async compile(request: ShaderCompileRequest): Promise<ShaderCompileResult> {
    this.latestRevision.set(
      request.source.uri,
      Math.max(request.revision, this.latestRevision.get(request.source.uri) ?? -1)
    );
    if (request.signal?.aborted)
      return Object.freeze({
        status: 'cancelled',
        revision: request.revision,
        diagnostics: Object.freeze([])
      });
    let closure;
    try {
      closure = await resolveShaderSource(request.source, this.options.resolver);
    } catch (error) {
      return Object.freeze({
        status: 'failed',
        revision: request.revision,
        diagnostics: Object.freeze([
          stageDiagnostic(request.source.uri, 'SHADER_SOURCE_RESOLVE', error, 'resolve')
        ])
      });
    }
    const parsed = parseFluxShader(closure);
    if (!parsed.ir)
      return Object.freeze({
        status: 'failed',
        revision: request.revision,
        diagnostics: parsed.diagnostics
      });
    const variants = resolveShaderVariants(
      parsed.ir.variants,
      request.variants,
      new Set(request.capabilities)
    );
    if (!variants.ok)
      return Object.freeze({
        status: 'failed',
        revision: request.revision,
        diagnostics: Object.freeze([
          variantDiagnostic(request.source.uri, variants.error.code, variants.error.message)
        ])
      });
    const validator = this.options.validators[request.target];
    if (!validator)
      return Object.freeze({
        status: 'failed',
        revision: request.revision,
        diagnostics: Object.freeze([
          variantDiagnostic(
            request.source.uri,
            'SHADER_VALIDATOR_MISSING',
            `No validator registered for ${request.target}.`
          )
        ])
      });
    const fingerprint = canonicalStringify({
      closure: closure.hash,
      language: request.source.languageVersion,
      versions: this.options.versions,
      target: request.target,
      entries: [...request.entries].sort(),
      variants: variants.key.value,
      capabilities: [...request.capabilities].sort(),
      translator:
        request.target === 'glsl300es' && this.options.webgl2Translator
          ? `${this.options.webgl2Translator.translatorId}@${this.options.webgl2Translator.version}`
          : undefined
    });
    const key = stableHash(fingerprint);
    const cached = this.cache.get(key, fingerprint);
    if (cached) {
      const artifact = cached.value;
      cached.release();
      if (this.latestRevision.get(request.source.uri) === request.revision)
        this.good.set(request.source.uri, artifact);
      return Object.freeze({
        status: 'cached',
        revision: request.revision,
        key,
        artifact,
        diagnostics: Object.freeze([])
      });
    }
    const emitted = await emitShaderBackend(parsed.ir, {
      target: request.target,
      variants,
      validator,
      ...(this.options.webgl2Translator ? { translator: this.options.webgl2Translator } : {}),
      ...(this.options.approvedWebGL2Extensions
        ? { approvedExtensions: this.options.approvedWebGL2Extensions }
        : {}),
      capabilities: request.capabilities,
      entries: request.entries
    });
    if (!emitted.ok)
      return Object.freeze({
        status: 'failed',
        revision: request.revision,
        key,
        diagnostics: emitted.diagnostics
      });
    if (request.signal?.aborted)
      return Object.freeze({
        status: 'cancelled',
        revision: request.revision,
        key,
        diagnostics: Object.freeze([])
      });
    let manifest: ShaderBindingManifest;
    try {
      manifest = createShaderBindingManifest(parsed.ir, this.options.versions.abi, request.target);
    } catch (error) {
      return Object.freeze({
        status: 'failed',
        revision: request.revision,
        key,
        diagnostics: Object.freeze([
          stageDiagnostic(request.source.uri, 'SHADER_LAYOUT_FAILED', error, 'layout')
        ])
      });
    }
    const artifact = Object.freeze({
      key,
      fingerprint,
      source: emitted.source,
      target: request.target,
      sourceUri: request.source.uri,
      variantKey: variants.key.value,
      manifest
    });
    this.cache.set(key, fingerprint, artifact).release();
    if (this.latestRevision.get(request.source.uri) === request.revision)
      this.good.set(request.source.uri, artifact);
    return Object.freeze({
      status: 'compiled',
      revision: request.revision,
      key,
      artifact,
      diagnostics: Object.freeze([])
    });
  }
  async prewarm(
    requests: readonly ShaderCompileRequest[]
  ): Promise<readonly ShaderCompileResult[]> {
    return Object.freeze(await Promise.all(requests.map((request) => this.compile(request))));
  }
  lastKnownGood(sourceUri: string): CompiledShaderArtifact | undefined {
    return this.good.get(sourceUri);
  }
  acceptFor(sourceUri: string, result: ShaderCompileResult, currentRevision: number): boolean {
    return (
      (result.status === 'compiled' || result.status === 'cached') &&
      result.artifact.sourceUri === sourceUri &&
      result.revision === currentRevision &&
      (this.latestRevision.get(sourceUri) ?? currentRevision) === currentRevision
    );
  }
}

function variantDiagnostic(uri: string, code: string, message: string): ShaderDiagnostic {
  return Object.freeze({
    severity: 'error',
    code,
    message,
    stage: 'capability',
    primary: Object.freeze({ uri, line: 1, column: 1, length: 1 }),
    related: Object.freeze([])
  });
}
function stageDiagnostic(
  uri: string,
  code: string,
  error: unknown,
  stage: ShaderDiagnostic['stage']
): ShaderDiagnostic {
  const message = error instanceof Error ? error.message : String(error);
  return Object.freeze({
    severity: 'error',
    code,
    message,
    stage,
    primary: Object.freeze({ uri, line: 1, column: 1, length: 1 }),
    related: Object.freeze([])
  });
}
