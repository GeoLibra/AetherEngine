/**
 * @file Bounded WGSL module linker combining dependency closures into standard WGSL.
 * Strictly preserves authoring source text without rewriting, rejects module-level directives
 * in multi-module closures, tracks 1-to-1 line segments, and accurately remaps compiler diagnostics.
 * Based on engine/design/v2/04-rendering/14-shader-modules.md.
 */

import {
  ShaderModuleLinkingError,
  type DependencyClosure,
  type LinkedSourceSegment,
  type LinkedWgslResult,
  type ModuleDiagnostic,
  type SourceSpan
} from './types';

/**
 * Strips line comments (`//`) and nested block comments (`/* ... /* ... *\/ ... *\/`) from WGSL source.
 * Preserves newlines so line numbers remain aligned where needed.
 *
 * @param source Authored WGSL source text.
 * @returns Cleaned code with comments removed.
 */
export function stripComments(source: string): string {
  let result = '';
  let i = 0;
  const len = source.length;

  while (i < len) {
    if (source[i] === '/' && source[i + 1] === '/') {
      // Line comment: skip until newline
      i += 2;
      while (i < len && source[i] !== '\n') {
        i++;
      }
    } else if (source[i] === '/' && source[i + 1] === '*') {
      // Block comment: supports nesting per WGSL spec
      i += 2;
      let depth = 1;
      while (i < len && depth > 0) {
        if (source[i] === '/' && source[i + 1] === '*') {
          depth++;
          i += 2;
        } else if (source[i] === '*' && source[i + 1] === '/') {
          depth--;
          i += 2;
        } else {
          if (source[i] === '\n') {
            result += '\n';
          }
          i++;
        }
      }
    } else {
      result += source[i];
      i++;
    }
  }

  return result;
}

const DIRECTIVE_PATTERN = /\b(enable|requires|diagnostic)\b/u;

/**
 * Links a resolved DependencyClosure into a valid, flat WGSL source string.
 *
 * Requirements:
 * - Dependencies are emitted in topological order, with the root module output last.
 * - Module source bodies are kept verbatim; no arbitrary rewriting or symbol renaming.
 * - Rejects module-level directives (`enable`, `requires`, `diagnostic`) in multi-module closures.
 * - Maintains an exact 1-to-1 line segment mapping for downstream diagnostic remapping.
 *
 * @param closure Topologically sorted DependencyClosure.
 * @returns Linked standard WGSL and segment tracking table.
 * @throws {ShaderModuleLinkingError} When composed modules contain unsupported module-level directives.
 */
export function linkStrictWgsl(closure: DependencyClosure): LinkedWgslResult {
  // If multiple modules participate, reject module-level directives
  if (closure.modules.length > 1) {
    for (const mod of closure.modules) {
      const stripped = stripComments(mod.content);
      const match = DIRECTIVE_PATTERN.exec(stripped);
      if (match) {
        throw new ShaderModuleLinkingError(
          `Module-level directive '${match[1]}' in module '${mod.id}' is not supported in composed shader modules under the current composition profile. Shaders requiring module-level directives must use a single-file entry point.`,
          'ERR_MODULE_DIRECTIVE_UNSUPPORTED',
          mod.id
        );
      }
    }
  }

  const segments: LinkedSourceSegment[] = [];
  const outputLines: string[] = [];

  for (let modIdx = 0; modIdx < closure.modules.length; modIdx++) {
    const mod = closure.modules[modIdx]!;
    const rawLines = mod.content.split(/\r?\n/);
    const startLineInOutput = outputLines.length + 1;

    for (const line of rawLines) {
      outputLines.push(line);
    }

    const endLineInOutput = outputLines.length;

    segments.push(
      Object.freeze({
        moduleId: mod.id,
        outputStartLine: startLineInOutput,
        outputEndLine: endLineInOutput,
        sourceStartLine: 1
      })
    );

    // Module boundary separator if not the last module
    if (modIdx < closure.modules.length - 1) {
      outputLines.push('');
    }
  }

  const standardWgsl = outputLines.join('\n');

  return Object.freeze({
    standardWgsl,
    rootId: closure.rootId,
    segments: Object.freeze(segments),
    compositeHash: closure.compositeHash
  });
}

/**
 * Remaps an error or diagnostic line number in the linked standard WGSL
 * back to the original source module and line number.
 *
 * @param diagnostic Error coordinate in linked WGSL.
 * @param linkedResult Linker output containing segment tables.
 * @returns Remapped ModuleDiagnostic pointing to the authoring module.
 */
export function remapLinkedDiagnostic(
  diagnostic: {
    readonly line: number;
    readonly column?: number | undefined;
    readonly message: string;
  },
  linkedResult: LinkedWgslResult
): ModuleDiagnostic {
  const line = diagnostic.line;

  for (const seg of linkedResult.segments) {
    if (line >= seg.outputStartLine && line <= seg.outputEndLine) {
      const offset = line - seg.outputStartLine;
      const originalLine = seg.sourceStartLine + offset;
      const span: SourceSpan = {
        line: originalLine,
        column: diagnostic.column
      };

      return Object.freeze({
        stage: 'validate',
        code: 'ERR_WGSL_COMPILE',
        message: diagnostic.message,
        moduleId: seg.moduleId,
        span
      });
    }
  }

  return Object.freeze({
    stage: 'validate',
    code: 'ERR_WGSL_COMPILE',
    message: diagnostic.message,
    moduleId: linkedResult.rootId,
    span: { line: diagnostic.line, column: diagnostic.column }
  });
}
