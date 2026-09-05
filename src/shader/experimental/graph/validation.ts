/**
 * @file Identifier validation, literal formatting, and diagnostic factories for ShaderGraph.
 */

import type { ShaderDiagnostic, SourceSpan } from '../../types';
import type { ShaderDataType } from './types';

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
