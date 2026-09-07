/**
 * @file Composes multiple WGSL source fragments into a unified shader module
 * while tracking source segment line ranges and remapping compilation diagnostics.
 */

import { NativeCookerError } from './native-wgsl-cooker';

/**
 * Input source fragment descriptor.
 */
export interface SourceFragmentInput {
  readonly path: string;
  readonly content: string;
}

/**
 * Recorded line span of a source fragment within the composed output.
 */
export interface ComposedSourceSegment {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly lineCount: number;
}

/**
 * Result of composing WGSL fragments.
 */
export interface ComposedSourceResult {
  readonly composedSource: string;
  readonly segments: readonly ComposedSourceSegment[];
}

/**
 * Mapped source code location.
 */
export interface SourceLocation {
  readonly path: string;
  readonly line: number;
  readonly column?: number | undefined;
}

/**
 * Composes multiple WGSL fragments into a single source string, tracking the 1-based
 * start and end lines of each fragment for deterministic error remapping.
 *
 * @param fragments List of file paths and WGSL source contents.
 * @returns Composed source string and segment span index.
 */
export function composeWgslFragments(
  fragments: readonly SourceFragmentInput[]
): ComposedSourceResult {
  const composedLines: string[] = [];
  const segments: ComposedSourceSegment[] = [];

  let index = 0;
  for (const fragment of fragments) {
    if (index > 0) {
      composedLines.push('');
    }
    index++;
    composedLines.push(`// --- Source Fragment: ${fragment.path} ---`);
    const startLine = composedLines.length + 1;
    const fragmentLines = fragment.content.split(/\r?\n/);
    for (const line of fragmentLines) {
      composedLines.push(line);
    }
    const endLine = composedLines.length;

    segments.push(
      Object.freeze({
        path: fragment.path,
        startLine,
        endLine,
        lineCount: fragmentLines.length
      })
    );
  }

  const composedSource = `${composedLines.join('\n')}\n`;
  return Object.freeze({
    composedSource,
    segments: Object.freeze(segments)
  });
}

/**
 * Maps a 1-based line and column in the composed shader source back to the original
 * fragment file path and relative line number.
 *
 * @param composedLine 1-based line number in the composed source.
 * @param segments Segment span table from composeWgslFragments.
 * @param composedColumn Optional 1-based column number.
 * @returns Mapped source location or undefined if line falls outside all fragment spans.
 */
export function mapComposedLocation(
  composedLine: number,
  segments: readonly ComposedSourceSegment[],
  composedColumn?: number
): SourceLocation | undefined {
  for (const segment of segments) {
    if (composedLine >= segment.startLine && composedLine <= segment.endLine) {
      return Object.freeze({
        path: segment.path,
        line: composedLine - segment.startLine + 1,
        column: composedColumn
      });
    }
  }
  return undefined;
}

function cleanCookErrorMessage(message: string, code: string): string {
  const prefix = `${code}:`;
  if (message.startsWith(prefix)) {
    return message.slice(prefix.length).trim();
  }
  return message.trim();
}

/**
 * Remaps a NativeCookerError diagnostic from composed line space back to the original
 * source fragment and relative line/column numbers.
 *
 * @param error The caught error (may be NativeCookerError or any error).
 * @param segments Segment span table from composeWgslFragments.
 * @returns A remapped error with updated location and message.
 */
export function remapCookerError(
  error: unknown,
  segments: readonly ComposedSourceSegment[]
): Error {
  if (!(error instanceof NativeCookerError)) {
    return error instanceof Error ? error : new Error(String(error));
  }

  let line = error.line;
  let col = error.column;

  if (line === undefined) {
    const lineMatch = /line\s+(\d+)/i.exec(error.message) ?? /:(\d+):(\d+)/.exec(error.message);
    if (lineMatch && lineMatch[1]) {
      line = parseInt(lineMatch[1], 10);
      if (lineMatch[2]) {
        col = parseInt(lineMatch[2], 10);
      }
    }
  }

  if (line !== undefined) {
    const mapped = mapComposedLocation(line, segments, col);
    if (mapped) {
      const colSuffix = mapped.column !== undefined ? `:${mapped.column}` : '';
      const mappedLocation = `${mapped.path}:${mapped.line}${colSuffix}`;
      const cleaned = cleanCookErrorMessage(error.message, error.code);
      const mappedMessage = `${error.code}: [${mappedLocation}] ${cleaned}`;

      return new NativeCookerError(mappedMessage, {
        code: error.code,
        sourceUri: mapped.path,
        rawStderr: error.rawStderr,
        line: mapped.line,
        column: mapped.column,
        backendStage: error.backendStage
      });
    }
  }

  return error;
}
