/**
 * @file Types and diagnostics for bounded Radiance RGBE import.
 */

export type HdrDiagnosticCode =
  | 'hdr-header-invalid'
  | 'hdr-dimensions-invalid'
  | 'hdr-limit-exceeded'
  | 'hdr-rle-invalid'
  | 'hdr-truncated'
  | 'hdr-legacy-rle-unsupported'
  | 'hdr-color-policy-unsupported'
  | 'environment-projection-unsupported'
  | 'environment-nonfinite'
  | 'environment-half-overflow';

export class HdrImportError extends Error {
  readonly code: HdrDiagnosticCode;
  readonly byteOffset?: number | undefined;
  readonly scanline?: number | undefined;

  constructor(
    code: HdrDiagnosticCode,
    message: string,
    options?: { byteOffset?: number; scanline?: number }
  ) {
    super(
      `[${code}] ${message}${options?.byteOffset !== undefined ? ` at offset ${options.byteOffset}` : ''}`
    );
    this.name = 'HdrImportError';
    this.code = code;
    this.byteOffset = options?.byteOffset;
    this.scanline = options?.scanline;
  }
}

export interface HdrHeaderMetadata {
  readonly format: string;
  readonly exposure?: number | undefined;
  readonly colorCorr?: readonly [number, number, number] | undefined;
  readonly gamma?: number | undefined;
  readonly primaries?:
    readonly [number, number, number, number, number, number, number, number] | undefined;
  readonly rawHeaderBytes: number;
}

export type AxisDirection = '+X' | '-X' | '+Y' | '-Y';

export interface HdrResolution {
  readonly outerAxis: AxisDirection;
  readonly outerCount: number;
  readonly innerAxis: AxisDirection;
  readonly innerCount: number;
  readonly canonicalWidth: number;
  readonly canonicalHeight: number;
}

export interface HdrImportOptions {
  readonly sourceColorSpace?: 'linear-srgb';
  readonly headerScalePolicy?: 'preserve-stored-values';
  readonly projection?: 'equirectangular' | 'none';
}

export interface CanonicalHdrPanorama {
  readonly width: number;
  readonly height: number;
  readonly pixels: Float32Array; // Row-major canonical linear sRGB Float32 (3 * width * height)
  readonly metadata: HdrHeaderMetadata;
}
