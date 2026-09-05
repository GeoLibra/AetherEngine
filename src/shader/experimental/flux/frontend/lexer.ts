import { spanAt } from './source-resolver';
import type { ShaderDiagnostic, SourceSpan } from '../../../types';

/**
 * Token kinds supported by the FluxSL grammar.
 */
export type FluxTokenKind = 'identifier' | 'number' | 'string' | 'symbol' | 'eof';

/**
 * A token extracted during lexing, with character positions and source span.
 */
export interface FluxToken {
  readonly kind: FluxTokenKind;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly span: SourceSpan;
}

export type FluxLexResult = Readonly<{
  tokens: readonly FluxToken[];
  diagnostics: readonly ShaderDiagnostic[];
}>;

const TWO_CHARACTER_SYMBOLS = new Set(['->', '==', '!=', '<=', '>=', '&&', '||', '<<', '>>']);
const ONE_CHARACTER_SYMBOLS = new Set('{}()[]<>,;:.@=+-*/%!&|^~');
const NO_RELATED_SPANS: readonly SourceSpan[] = Object.freeze([]);

/**
 * Performs lexical analysis on FluxSL source text.
 * Skips whitespace and comments, groups characters into tokens, and flags illegal characters.
 */
export function lexFluxSource(uri: string, source: string): FluxLexResult {
  const tokens: FluxToken[] = [];
  const diagnostics: ShaderDiagnostic[] = [];
  let index = 0;
  const emit = (kind: FluxTokenKind, start: number, end: number) =>
    tokens.push(
      Object.freeze({
        kind,
        text: source.slice(start, end),
        start,
        end,
        span: spanAt(uri, source, start, Math.max(1, end - start))
      })
    );
  while (index < source.length) {
    const character = source[index]!;
    // Skip whitespace
    if (/\s/.test(character)) {
      index++;
      continue;
    }
    // Skip single-line comments
    if (character === '/' && source[index + 1] === '/') {
      index += 2;
      while (index < source.length && source[index] !== '\n') index++;
      continue;
    }
    // Skip multi-line comments and check for unterminated EOF
    if (character === '/' && source[index + 1] === '*') {
      const start = index;
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/'))
        index++;
      if (index >= source.length) {
        diagnostics.push(
          makeDiagnostic(
            'FLUX_UNEXPECTED_EOF',
            'Unterminated block comment.',
            spanAt(uri, source, start, source.length - start)
          )
        );
        break;
      }
      index += 2;
      continue;
    }
    // Read identifiers
    if (/[A-Za-z_]/.test(character)) {
      const start = index++;
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index]!)) index++;
      emit('identifier', start, index);
      continue;
    }
    // Read numeric literals (supporting hex, decimals, and exponents/suffixes)
    if (/\d/.test(character) || (character === '.' && /\d/.test(source[index + 1] ?? ''))) {
      const start = index++;
      while (index < source.length && /[0-9A-Fa-f_xX.]/.test(source[index]!)) index++;
      if (/[eE]/.test(source[index] ?? '')) {
        index++;
        if (/[+-]/.test(source[index] ?? '')) index++;
        while (/\d/.test(source[index] ?? '')) index++;
      }
      if (/[fiu]/.test(source[index] ?? '')) index++;
      emit('number', start, index);
      continue;
    }
    // Read string literals and escape characters
    if (character === '"') {
      const start = index++;
      while (index < source.length && source[index] !== '"') {
        if (source[index] === '\\') index++;
        index++;
      }
      if (index >= source.length) {
        diagnostics.push(
          makeDiagnostic(
            'FLUX_UNEXPECTED_EOF',
            'Unterminated string literal.',
            spanAt(uri, source, start, source.length - start)
          )
        );
        break;
      }
      index++;
      emit('string', start, index);
      continue;
    }
    // Read multi-character symbols
    const pair = source.slice(index, index + 2);
    if (TWO_CHARACTER_SYMBOLS.has(pair)) {
      emit('symbol', index, index + 2);
      index += 2;
      continue;
    }
    // Read single-character symbols
    if (ONE_CHARACTER_SYMBOLS.has(character)) {
      emit('symbol', index, index + 1);
      index++;
      continue;
    }
    // Report syntax error for unrecognized character
    diagnostics.push(
      makeDiagnostic(
        'FLUX_UNSUPPORTED_SYNTAX',
        `Unsupported character "${character}".`,
        spanAt(uri, source, index, 1)
      )
    );
    index++;
  }
  emit('eof', source.length, source.length);
  return Object.freeze({ tokens: Object.freeze(tokens), diagnostics: Object.freeze(diagnostics) });
}

function makeDiagnostic(code: string, message: string, primary: SourceSpan): ShaderDiagnostic {
  return Object.freeze({
    severity: 'error',
    code,
    message,
    stage: 'parse',
    primary,
    related: NO_RELATED_SPANS
  });
}
