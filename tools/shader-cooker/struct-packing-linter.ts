/**
 * @file WGSL struct memory alignment and layout diagnostic analyzer.
 *
 * Analyzes cooked buffer layouts to provide factual reporting of internal alignment gaps
 * and padding between adjacent reflected fields as directly emitted by Naga, using neutral
 * terminology without assuming non-optimizable ABI gaps represent waste.
 */

import type { CookedShaderBufferLayout, CookedShaderRuntimeArtifact } from '../../src/shader/types';

/**
 * Information about a factual internal alignment gap or padding between two adjacent fields.
 */
export interface StructLayoutGap {
  readonly beforeField: string;
  readonly afterField: string;
  readonly offset: number;
  readonly size: number;
}

/**
 * Result of analyzing a buffer struct's layout based on factual internal alignment gaps and padding.
 */
export interface StructLayoutDiagnosis {
  readonly structName: string;
  readonly group: number;
  readonly binding: number;
  readonly totalSize: number;
  readonly paddingBytes: number;
  readonly hasGaps: boolean;
  readonly gaps: readonly StructLayoutGap[];
  readonly currentFieldOrder: readonly string[];
}

/**
 * Analyzes one buffer layout to detect factual internal alignment gaps between adjacent fields.
 *
 * @param layout Reflected buffer layout from native cooker.
 * @returns Factual layout diagnosis containing reflected gaps and padding bytes.
 */
export function diagnoseStructLayout(layout: CookedShaderBufferLayout): StructLayoutDiagnosis {
  const fields = layout.fields;
  const gaps: StructLayoutGap[] = [];

  // Detect factual internal alignment gaps between adjacent reflected fields
  for (let i = 0; i < fields.length - 1; i++) {
    const current = fields[i]!;
    const next = fields[i + 1]!;
    const currentEnd = current.offset + current.size;
    if (next.offset > currentEnd) {
      const gapSize = next.offset - currentEnd;
      gaps.push(
        Object.freeze({
          beforeField: current.path,
          afterField: next.path,
          offset: currentEnd,
          size: gapSize
        })
      );
    }
  }

  const paddingBytes = gaps.reduce((sum, gap) => sum + gap.size, 0);

  return Object.freeze({
    structName: layout.name,
    group: layout.group,
    binding: layout.binding,
    totalSize: layout.byteSize,
    paddingBytes,
    hasGaps: gaps.length > 0,
    gaps: Object.freeze(gaps),
    currentFieldOrder: Object.freeze(fields.map((f) => f.path))
  });
}

/**
 * Evaluates all uniform and storage buffer structures in a cooked shader artifact for layout gaps.
 *
 * @param artifact Cooked runtime shader artifact.
 * @returns Array of layout diagnoses for structures that contain internal alignment gaps.
 */
export function diagnoseShaderArtifactLayouts(
  artifact: CookedShaderRuntimeArtifact
): readonly StructLayoutDiagnosis[] {
  const diagnoses: StructLayoutDiagnosis[] = [];

  for (const layout of artifact.bufferLayouts) {
    const diagnosis = diagnoseStructLayout(layout);
    if (diagnosis.hasGaps) {
      diagnoses.push(diagnosis);
    }
  }

  return Object.freeze(diagnoses);
}

/**
 * Formats a single struct layout diagnosis into a neutral informational diagnostic message.
 *
 * @param diagnosis Factual layout diagnosis.
 * @param sourceUri Optional shader source URI for context.
 * @returns Formatted neutral diagnostic string.
 */
export function formatStructLayoutDiagnostic(
  diagnosis: StructLayoutDiagnosis,
  sourceUri?: string
): string {
  const uriPrefix = sourceUri ? ` in "${sourceUri}"` : '';
  const lines: string[] = [
    `ℹ️  [WGSL Struct Layout Diagnostic] Buffer '${diagnosis.structName}' (@group(${diagnosis.group}) @binding(${diagnosis.binding}))${uriPrefix}:`,
    `   Total size: ${diagnosis.totalSize} bytes (${diagnosis.paddingBytes} padding/gap byte(s) across ${diagnosis.gaps.length} alignment gap(s))`
  ];

  if (diagnosis.gaps.length > 0) {
    lines.push('   Alignment gaps / padding:');
    for (const gap of diagnosis.gaps) {
      lines.push(
        `     - ${gap.size} bytes padding between '${gap.beforeField}' and '${gap.afterField}' (offset ${gap.offset})`
      );
    }
  }

  return lines.join('\n');
}
