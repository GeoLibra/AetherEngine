/**
 * @file Identifier validation, literal formatting, and diagnostic factories for ShaderGraph.
 */

import type { ShaderDiagnostic, SourceSpan } from '../../types';
import { getShaderNodeDefinition } from './registry';
import type { ShaderDataType, ShaderGraphNode, ShaderNodeDefinition, ShaderStage } from './types';

const WGSL_IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/u;
const WGSL_RESERVED_KEYWORDS = new Set([
  'alias',
  'break',
  'case',
  'const',
  'const_assert',
  'continue',
  'continuing',
  'default',
  'diagnostic',
  'discard',
  'else',
  'enable',
  'false',
  'fn',
  'for',
  'if',
  'let',
  'loop',
  'override',
  'requires',
  'return',
  'struct',
  'switch',
  'true',
  'var',
  'while',
  'type',
  'null',
  'void',
  'self',
  'super'
]);

/**
 * Validates that an identifier string is a legal WGSL identifier and not a reserved keyword.
 */
export function isValidWgslIdentifier(id: string): boolean {
  return WGSL_IDENTIFIER_PATTERN.test(id) && !WGSL_RESERVED_KEYWORDS.has(id);
}

export type LiteralFormatResult =
  Readonly<{ ok: true; literal: string }> | Readonly<{ ok: false; message: string }>;

/**
 * Formats and strictly validates a value into a safe WGSL literal.
 * Prevents raw string injection paths.
 */
export function formatWgslLiteral(value: unknown, outputType: string): LiteralFormatResult {
  if (outputType === 'bool') {
    if (typeof value === 'boolean') {
      return { ok: true, literal: value ? 'true' : 'false' };
    }
    return { ok: false, message: `Expected boolean for type "bool", received ${typeof value}.` };
  }
  if (outputType === 'f32') {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return { ok: true, literal: Number.isInteger(value) ? `${value}.0` : `${value}` };
    }
    return {
      ok: false,
      message: `Expected finite number for type "f32", received ${String(value)}.`
    };
  }
  if (outputType === 'i32') {
    if (
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= -2147483648 &&
      value <= 2147483647
    ) {
      return { ok: true, literal: `${value}i` };
    }
    return {
      ok: false,
      message: `Expected 32-bit signed integer for type "i32", received ${String(value)}.`
    };
  }
  if (outputType === 'u32') {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 4294967295) {
      return { ok: true, literal: `${value}u` };
    }
    return {
      ok: false,
      message: `Expected 32-bit unsigned integer for type "u32", received ${String(value)}.`
    };
  }
  if (outputType === 'vec2f' || outputType === 'vec2<f32>') {
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      value.every((v) => typeof v === 'number' && Number.isFinite(v))
    ) {
      return {
        ok: true,
        literal: `vec2f(${value.map((v) => (Number.isInteger(v) ? `${v}.0` : `${v}`)).join(', ')})`
      };
    }
    return { ok: false, message: `Expected 2-element finite number array for "${outputType}".` };
  }
  if (outputType === 'vec3f' || outputType === 'vec3<f32>') {
    if (
      Array.isArray(value) &&
      value.length === 3 &&
      value.every((v) => typeof v === 'number' && Number.isFinite(v))
    ) {
      return {
        ok: true,
        literal: `vec3f(${value.map((v) => (Number.isInteger(v) ? `${v}.0` : `${v}`)).join(', ')})`
      };
    }
    return { ok: false, message: `Expected 3-element finite number array for "${outputType}".` };
  }
  if (outputType === 'vec4f' || outputType === 'vec4<f32>') {
    if (
      Array.isArray(value) &&
      value.length === 4 &&
      value.every((v) => typeof v === 'number' && Number.isFinite(v))
    ) {
      return {
        ok: true,
        literal: `vec4f(${value.map((v) => (Number.isInteger(v) ? `${v}.0` : `${v}`)).join(', ')})`
      };
    }
    return { ok: false, message: `Expected 4-element finite number array for "${outputType}".` };
  }
  return { ok: false, message: `Unsupported literal type "${outputType}".` };
}

/**
 * Formats entry point return expression based on output type and target stage.
 */
export function formatReturnExpression(
  outputId: string,
  outputType: string,
  stage: string
): string {
  if (stage === 'fragment') {
    if (outputType === 'vec4f' || outputType === 'vec4<f32>') {
      return outputId;
    }
    if (outputType === 'vec3f' || outputType === 'vec3<f32>') {
      return `vec4f(${outputId}, 1.0)`;
    }
    if (outputType === 'vec2f' || outputType === 'vec2<f32>') {
      return `vec4f(${outputId}, 0.0, 1.0)`;
    }
    if (outputType === 'f32') {
      return `vec4f(${outputId}, ${outputId}, ${outputId}, 1.0)`;
    }
    return `vec4f(${outputId})`;
  }
  if (stage === 'vertex') {
    if (outputType === 'vec4f' || outputType === 'vec4<f32>') {
      return outputId;
    }
    if (outputType === 'vec3f' || outputType === 'vec3<f32>') {
      return `vec4f(${outputId}, 1.0)`;
    }
    return `vec4f(${outputId})`;
  }
  return outputId;
}

const NO_RELATED_SPANS: readonly SourceSpan[] = Object.freeze([]);

function graphSpan(): SourceSpan {
  return Object.freeze({ uri: 'shadergraph://generated', line: 1, column: 1, length: 1 });
}

export function graphDiagnostic(code: string, message: string): ShaderDiagnostic {
  return Object.freeze({
    severity: 'error',
    code,
    message,
    stage: 'typecheck',
    primary: graphSpan(),
    related: NO_RELATED_SPANS
  });
}

/**
 * Derives a specific, actionable diagnostic for why a node signature failed to match.
 */
export function diagnoseSignatureFailure(
  node: ShaderGraphNode,
  definition: ShaderNodeDefinition,
  providedInputs: Readonly<Record<string, ShaderDataType>>,
  usedStages: ReadonlySet<ShaderStage>
): ShaderDiagnostic {
  // Check if failure is due to stage mismatch
  const allSigStages = new Set(definition.signatures.map((s) => s.stage));
  if (!allSigStages.has('all')) {
    for (const stage of usedStages) {
      if (!allSigStages.has(stage)) {
        return graphDiagnostic(
          'GRAPH_STAGE_MISMATCH',
          `Node "${node.id}" of kind "${node.kind}" is not valid in "${stage}" stage.`
        );
      }
    }
  }

  // Check port names
  const allPortIds = new Set(definition.signatures.flatMap((s) => s.inputs.map((p) => p.id)));
  for (const inputKey of Object.keys(providedInputs)) {
    if (!allPortIds.has(inputKey)) {
      return graphDiagnostic(
        'GRAPH_INVALID_PORT',
        `Node "${node.id}" received unexpected input port "${inputKey}".`
      );
    }
  }

  // Check missing ports
  for (const sig of definition.signatures) {
    if (sig.inputs.length > 0 && Object.keys(providedInputs).length < sig.inputs.length) {
      for (const requiredPort of sig.inputs) {
        if (!(requiredPort.id in providedInputs)) {
          return graphDiagnostic(
            'GRAPH_MISSING_PORT',
            `Node "${node.id}" of kind "${node.kind}" is missing required input port "${requiredPort.id}".`
          );
        }
      }
    }
  }

  // Check port types
  return graphDiagnostic(
    'GRAPH_TYPE_MISMATCH',
    `Node "${node.id}" received incompatible port types: ${Object.entries(providedInputs)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ')}.`
  );
}

/**
 * Validates initial node correctness: ID uniqueness, valid WGSL identifier,
 * known node type in registry, and non-empty input validation.
 */
export function validateGraphNodes(
  nodes: readonly ShaderGraphNode[]
): ShaderDiagnostic | undefined {
  const seenIds = new Set<string>();
  for (const node of nodes) {
    if (seenIds.has(node.id)) {
      return graphDiagnostic(
        'GRAPH_DUPLICATE_NODE_ID',
        `ShaderGraph contains duplicate node ID "${node.id}".`
      );
    }
    if (!isValidWgslIdentifier(node.id)) {
      return graphDiagnostic(
        'GRAPH_INVALID_IDENTIFIER',
        `Node ID "${node.id}" is not a valid WGSL identifier.`
      );
    }
    const def = getShaderNodeDefinition(node.kind);
    if (!def) {
      return graphDiagnostic(
        'GRAPH_UNKNOWN_NODE_TYPE',
        `Unknown node type "${node.kind}" on node "${node.id}".`
      );
    }

    const inputKeys = Object.keys(node.inputs ?? {});
    if (def.signatures.length > 0) {
      const anySigInputs = def.signatures[0]!.inputs;
      if (anySigInputs.length === 0 && inputKeys.length > 0) {
        return graphDiagnostic(
          'GRAPH_INVALID_PORT',
          `Node "${node.id}" of kind "${node.kind}" must not have inputs.`
        );
      }
      const allPortIds = new Set(def.signatures.flatMap((s) => s.inputs.map((p) => p.id)));
      for (const inputKey of inputKeys) {
        if (!allPortIds.has(inputKey)) {
          return graphDiagnostic(
            'GRAPH_INVALID_PORT',
            `Node "${node.id}" received unexpected input port "${inputKey}".`
          );
        }
      }
    }

    seenIds.add(node.id);
  }
  return undefined;
}
