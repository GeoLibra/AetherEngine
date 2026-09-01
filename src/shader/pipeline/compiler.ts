import { emitShaderBackend, type ShaderBackendValidator } from '../backends/backend-emitter';
import { ShaderArtifactCache } from './cache';
import { canonicalStringify, stableHash } from '../../core/hash';
import { parseFluxShader } from '../frontend/parser';
import { createShaderBindingManifest } from '../layout/binding-reflection';
import { resolveShaderSource } from '../frontend/source-resolver';
import { resolveShaderVariants } from './variant';
import type { WebGL2ShaderTranslationPort } from '../../rhi/webgl2/types';
import type { WebGL2ClipDepthMode } from '../../rhi/webgl2/pipeline/clip-depth';
import type {
  ShaderBindingRequirement,
  ShaderBindingManifest,
  ShaderCompileRequest,
  ShaderDiagnostic,
  ShaderSourceResolver,
  ShaderTarget,
  SourceSpan
} from '../types';

const NO_SHADER_DIAGNOSTICS: readonly ShaderDiagnostic[] = Object.freeze([]);
const NO_RELATED_SPANS: readonly SourceSpan[] = Object.freeze([]);

/**
 * The compiled output artifact of the compiler, addressable by content hash fingerprint.
 */
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

/**
 * ShaderCompiler orchestrates the compilation of FluxSL shaders into target-backend
 * code (WGSL or GLSL) with layouts generated for the target APIs.
 *
 * Features an in-memory LRU cache and tracking of last-known-good states to allow
 * graceful fallback in the event of editor recompilation errors.
 */
export class ShaderCompiler {
  private readonly cache = new ShaderArtifactCache<CompiledShaderArtifact>({ maxEntries: 64 });
  // Tracks the highest compile request revision received for each file URI to ignore stale results.
  private readonly latestRevision = new Map<string, number>();
  // Caches the last successfully compiled shader artifact for hot-reload fallback.
  private readonly good = new Map<string, CompiledShaderArtifact>();

  constructor(
    private readonly options: Readonly<{
      resolver: ShaderSourceResolver;
      validators: Partial<Record<ShaderTarget, ShaderBackendValidator>>;
      webgl2Translator?: WebGL2ShaderTranslationPort;
      approvedWebGL2Extensions?: readonly string[];
      webgl2ClipDepthMode?: WebGL2ClipDepthMode;
      versions: Readonly<{ compiler: number; ir: number; abi: number; backend: number }>;
    }>
  ) {}

  /**
   * Compiles the source defined in compile request for the requested backend target.
   *
   * Lifecycle Stages:
   * 1. Resolves module import and include dependencies (`resolveShaderSource`).
   * 2. Lexes and parses the files into Frontend AST and lowers to IR (`parseFluxShader`).
   * 3. Selects and specializes variant parameters (`resolveShaderVariants`).
   * 4. Queries the LRU cache using a complete serialized fingerprint.
   * 5. Translates IR to backend source (WebGL2/GLSL translation or WGSL emit) and validates.
   * 6. Measures buffer field offsets for the specialized pipeline.
   * 7. Caches and returns the compiled artifact.
   */
  async compile(request: ShaderCompileRequest): Promise<ShaderCompileResult> {
    this.latestRevision.set(
      request.source.uri,
      Math.max(request.revision, this.latestRevision.get(request.source.uri) ?? -1)
    );
    if (request.signal?.aborted)
      return Object.freeze({
        status: 'cancelled',
        revision: request.revision,
        diagnostics: NO_SHADER_DIAGNOSTICS
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
    const bindingRequirements = canonicalBindingRequirements(request.bindingRequirements ?? []);
    const fingerprint = canonicalStringify({
      closure: closure.hash,
      language: request.source.languageVersion,
      versions: this.options.versions,
      target: request.target,
      entries: [...request.entries].sort(),
      variants: variants.key.value,
      capabilities: [...request.capabilities].sort(),
      bindingRequirements,
      translator:
        request.target === 'glsl300es' && this.options.webgl2Translator
          ? `${this.options.webgl2Translator.translatorId}@${this.options.webgl2Translator.version}`
          : undefined,
      webgl2ClipDepthMode:
        request.target === 'glsl300es'
          ? (this.options.webgl2ClipDepthMode ?? 'vertex-remap')
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
        diagnostics: NO_SHADER_DIAGNOSTICS
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
      ...(this.options.webgl2ClipDepthMode
        ? { webgl2ClipDepthMode: this.options.webgl2ClipDepthMode }
        : {}),
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
        diagnostics: NO_SHADER_DIAGNOSTICS
      });
    let manifest: ShaderBindingManifest;
    try {
      manifest = createShaderBindingManifest(parsed.ir, this.options.versions.abi, request.target, {
        bindingRequirements
      });
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
      diagnostics: NO_SHADER_DIAGNOSTICS
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

function canonicalBindingRequirements(
  requirements: readonly ShaderBindingRequirement[]
): readonly ShaderBindingRequirement[] {
  return Object.freeze(
    requirements
      .map((requirement) => Object.freeze({ ...requirement }))
      .sort(
        (left, right) =>
          left.group - right.group ||
          left.binding - right.binding ||
          compareCodeUnits(left.kind, right.kind) ||
          compareCodeUnits(left.samplerType, right.samplerType)
      )
  );
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function variantDiagnostic(uri: string, code: string, message: string): ShaderDiagnostic {
  return Object.freeze({
    severity: 'error',
    code,
    message,
    stage: 'capability',
    primary: Object.freeze({ uri, line: 1, column: 1, length: 1 }),
    related: NO_RELATED_SPANS
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
    related: NO_RELATED_SPANS
  });
}
