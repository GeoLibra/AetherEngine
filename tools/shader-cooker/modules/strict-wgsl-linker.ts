/**
 * @file Strict-WGSL linker candidate for combining dependency closures into standard WGSL.
 * Performs deterministic directive hoisting, import removal, segment tracking, and error remapping.
 */

import {
  type DependencyClosure,
  type LinkedSourceSegment,
  type LinkedWgslResult,
  type ModuleDiagnostic,
  type ShaderModuleId,
  type SourceSpan
} from './types';

/**
 * Links a resolved DependencyClosure into a valid, flat WGSL source string.
 * - Hoists unique `enable` and `diagnostic` directives to the top of the file.
 * - Strips import statements while preserving original line structure (replaces with blank lines or comments)
 *   so line numbers within each module stay stable.
 * - Maintains an exact line mapping table for diagnostic remapping.
 */
export function linkStrictWgsl(closure: DependencyClosure): LinkedWgslResult {
  const hoistedDirectives = new Set<string>();
  const segments: LinkedSourceSegment[] = [];
  const outputLines: string[] = [];

  // 1. Collect and deduplicate directives from all modules in the closure
  for (const mod of closure.modules) {
    for (const dir of mod.directives) {
      hoistedDirectives.add(dir);
    }
  }

  // 2. Emit hoisted directives at the top
  const sortedDirectives = [...hoistedDirectives].sort();
  for (const dir of sortedDirectives) {
    outputLines.push(dir);
  }
  if (sortedDirectives.length > 0) {
    outputLines.push(''); // blank line separator
  }

  // 3. Process modules in topological order
  for (const mod of closure.modules) {
    const rawLines = mod.content.split('\n');
    const startLineInOutput = outputLines.length + 1;

    // Filter module lines: comment out import statements and hoisted directives
    for (let i = 0; i < rawLines.length; i++) {
      const line = rawLines[i]!;
      const trimmed = line.trim();

      const isImport =
        trimmed.startsWith('#import ') || (trimmed.startsWith('import ') && trimmed.endsWith(';'));

      const isDirective =
        (trimmed.startsWith('enable ') || trimmed.startsWith('diagnostic(')) &&
        trimmed.endsWith(';');

      if (isImport || isDirective) {
        // Replace with empty line to preserve 1-to-1 line correspondence within module segment
        outputLines.push(`// [linked: ${trimmed}]`);
      } else {
        outputLines.push(line);
      }
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

    // Module boundary separator
    outputLines.push('');
  }

  const standardWgsl = outputLines.join('\n');

  return Object.freeze({
    standardWgsl,
    rootId: closure.rootId,
    segments: Object.freeze(segments),
    hoistedDirectives: Object.freeze(sortedDirectives),
    compositeHash: closure.compositeHash
  });
}

/**
 * Remaps an error or diagnostic line number in the linked standard WGSL
 * back to the original source module and line number.
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

  // If outside recorded segments (e.g. hoisted directives)
  return Object.freeze({
    stage: 'validate',
    code: 'ERR_WGSL_COMPILE',
    message: diagnostic.message,
    moduleId: linkedResult.rootId,
    span: { line: diagnostic.line, column: diagnostic.column }
  });
}
