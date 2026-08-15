import type { WebGL2ShaderTranslationPort } from '../rhi/webgl2/types';
import { finalizeWebGL2Shader } from '../rhi/webgl2/shader-finalization';
import type { WebGL2ClipDepthMode } from '../rhi/webgl2/clip-depth';
import { emitWgslModule } from './wgsl-emitter';
import { GLSL_ES_EMITTER_VERSION, emitGlslEsModule } from './backends/glsl-es';
import {
  collectGlslTextureSamplerUses,
  fuseGlslTextureSamplerBindings
} from './backends/glsl-binding-fusion';
import { reflectBindingEntry } from './binding-reflection';
import type { ShaderDiagnostic, ShaderModuleIR, ShaderTarget, SourceSpan } from './types';
import type { ResolvedShaderVariants } from './variant';

const NO_SHADER_DIAGNOSTICS: readonly ShaderDiagnostic[] = Object.freeze([]);
const NO_RELATED_SPANS: readonly SourceSpan[] = Object.freeze([]);

export interface ShaderBackendValidationIssue {
  readonly line: number;
  readonly column: number;
  readonly message: string;
  readonly log?: string;
}
export interface ShaderBackendValidator {
  validate(
    input: Readonly<{ target: ShaderTarget; source: string; entries: readonly string[] }>
  ): Promise<readonly ShaderBackendValidationIssue[]>;
}
export type ShaderBackendResult =
  | Readonly<{ ok: true; source: string; diagnostics: readonly ShaderDiagnostic[] }>
  | Readonly<{ ok: false; diagnostics: readonly ShaderDiagnostic[] }>;

export async function emitShaderBackend(
  ir: ShaderModuleIR,
  options: Readonly<{
    target: ShaderTarget;
    variants: ResolvedShaderVariants;
    validator: ShaderBackendValidator;
    translator?: WebGL2ShaderTranslationPort;
    approvedExtensions?: readonly string[];
    capabilities?: readonly string[];
    webgl2ClipDepthMode?: WebGL2ClipDepthMode;
    entries?: readonly string[];
  }>
): Promise<ShaderBackendResult> {
  const entries = options.entries ?? ir.entryPoints.map((entry) => entry.name);
  const selectedEntries = ir.entryPoints.filter((entry) => entries.includes(entry.name));
  const wgsl = `// FluxSL typed IR ${ir.version}\n// variants ${options.variants.key.value}\n${emitWgslModule(ir, entries)}`;
  let source = wgsl;
  if (options.target === 'glsl300es') {
    const selectedEntry = selectedEntries.length === 1 ? selectedEntries[0] : undefined;
    if (selectedEntry === undefined || selectedEntry.stage === 'compute') {
      return failure(
        'SHADER_TRANSLATOR_UNSUPPORTED_STAGE',
        'WebGL2 translation requires exactly one vertex or fragment entry point.',
        primarySpan(ir)
      );
    }
    try {
      const constants = numericVariantConstants(ir, options.variants.values);
      if (options.translator !== undefined) {
        const translated = options.translator.translate(
          Object.freeze({
            wgsl,
            stage: selectedEntry.stage,
            entryPoint: selectedEntry.name,
            constants,
            capabilities: Object.freeze([...(options.capabilities ?? [])]),
            approvedExtensions: Object.freeze([...(options.approvedExtensions ?? [])]),
            clipDepthMode: options.webgl2ClipDepthMode ?? 'vertex-remap'
          })
        );
        source = finalizeWebGL2Shader(options.translator, translated, {
          constants,
          approvedExtensions: options.approvedExtensions ?? []
        }).source;
      } else {
        source = finalizeTypedGlsl(ir, selectedEntry.name, constants);
      }
    } catch (error) {
      return failure(
        'SHADER_TRANSLATION_FAILED',
        error instanceof Error ? error.message : String(error),
        primarySpan(ir)
      );
    }
  }
  let issues: readonly ShaderBackendValidationIssue[];
  try {
    issues = await options.validator.validate(
      Object.freeze({ target: options.target, source, entries: Object.freeze([...entries]) })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Object.freeze({
      ok: false,
      diagnostics: Object.freeze([
        Object.freeze({
          severity: 'error',
          code: 'SHADER_BACKEND_EXCEPTION',
          message: 'Shader backend validator failed.',
          stage: 'backend-validation',
          primary:
            ir.entryPoints[0]?.span ??
            Object.freeze({ uri: 'shader://generated', line: 1, column: 1, length: 1 }),
          related: NO_RELATED_SPANS,
          backendLog: message
        })
      ])
    });
  }
  if (issues.length === 0)
    return Object.freeze({ ok: true, source, diagnostics: NO_SHADER_DIAGNOSTICS });
  const primary =
    ir.entryPoints[0]?.span ??
    Object.freeze({ uri: 'shader://generated', line: 1, column: 1, length: 1 });
  return Object.freeze({
    ok: false,
    diagnostics: Object.freeze(issues.map((issue) => backendDiagnostic(issue, primary)))
  });
}

function finalizeTypedGlsl(
  ir: ShaderModuleIR,
  entryName: string,
  constants: Readonly<Record<string, number>>
): string {
  const bindings = ir.globals
    .filter((global) => global.group !== undefined && global.binding !== undefined)
    .map((global) =>
      reflectBindingEntry(
        global.group!,
        global.binding!,
        global.name,
        global.type,
        global.addressSpace,
        undefined
      )
    );
  const combinedSamplers = fuseGlslTextureSamplerBindings(
    bindings,
    collectGlslTextureSamplerUses(ir),
    16
  );
  const defines = Object.entries(constants)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => `#define ${name} ${value}`);
  return [
    '#version 300 es',
    `// Aether typed GLSL ES emitter ${GLSL_ES_EMITTER_VERSION}`,
    ...defines,
    emitGlslEsModule(ir, entryName, combinedSamplers)
  ].join('\n');
}

function numericVariantConstants(
  ir: ShaderModuleIR,
  values: Readonly<Record<string, boolean | string | number>>
): Readonly<Record<string, number>> {
  const result: Record<string, number> = {};
  for (const [name, value] of Object.entries(values)) {
    if (typeof value === 'boolean') result[name] = value ? 1 : 0;
    else if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('Variant numeric literal must be finite.');
      result[name] = value;
    } else {
      const dimension = ir.variants.find((candidate) => candidate.name === name);
      const index = dimension?.values?.indexOf(value) ?? -1;
      if (index < 0) throw new Error(`Variant enum literal "${value}" is not declared by ${name}.`);
      result[name] = index;
    }
  }
  return Object.freeze(result);
}

function primarySpan(ir: ShaderModuleIR): SourceSpan {
  return (
    ir.entryPoints[0]?.span ??
    Object.freeze({ uri: 'shader://generated', line: 1, column: 1, length: 1 })
  );
}

function failure(code: string, message: string, primary: SourceSpan): ShaderBackendResult {
  return Object.freeze({
    ok: false,
    diagnostics: Object.freeze([
      Object.freeze({
        severity: 'error',
        code,
        message,
        stage: 'emit',
        primary,
        related: NO_RELATED_SPANS
      })
    ])
  });
}
function backendDiagnostic(
  issue: ShaderBackendValidationIssue,
  authored: SourceSpan
): ShaderDiagnostic {
  return Object.freeze({
    severity: 'error',
    code: 'SHADER_BACKEND_VALIDATION',
    message: issue.message,
    stage: 'backend-validation',
    primary: authored,
    related: NO_RELATED_SPANS,
    ...(issue.log ? { backendLog: issue.log } : {})
  });
}
