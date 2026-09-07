/**
 * @file Bounded Radiance RGBE importer.
 * Pure decoder with strict safety limits, canonical equirectangular projection validation,
 * modern 4-plane RLE / flat decoding, and Float32 canonical row-major layout.
 */

import { HDR_LIMITS, HDR_MAGIC_SIGNATURES, HDR_REQUIRED_FORMAT } from './constants';
import {
  type AxisDirection,
  type CanonicalHdrPanorama,
  type HdrHeaderMetadata,
  type HdrImportOptions,
  type HdrResolution,
  HdrImportError
} from './types';

interface HeaderParseResult {
  readonly metadata: HdrHeaderMetadata;
  readonly resolution: HdrResolution;
  readonly dataOffset: number;
}

function parseHeaderLine(
  bytes: Uint8Array,
  start: number,
  maxEnd: number
): { line: string; nextOffset: number } {
  let end = start;
  while (end < maxEnd && bytes[end] !== 0x0a) {
    if (bytes[end] === 0x00) {
      throw new HdrImportError('hdr-header-invalid', 'Embedded NUL character in header line.', {
        byteOffset: end
      });
    }
    end++;
    if (end - start > HDR_LIMITS.MAX_LINE_BYTES) {
      throw new HdrImportError(
        'hdr-limit-exceeded',
        `Header line exceeds ${HDR_LIMITS.MAX_LINE_BYTES} bytes limit.`,
        { byteOffset: start }
      );
    }
  }

  if (end >= maxEnd && (end === start || bytes[end - 1] !== 0x0a)) {
    throw new HdrImportError(
      'hdr-truncated',
      'Header ended unexpectedly before line termination.',
      { byteOffset: end }
    );
  }

  let lineEnd = end;
  if (lineEnd > start && bytes[lineEnd - 1] === 0x0d) {
    lineEnd--;
  }

  const line = new TextDecoder('ascii').decode(bytes.subarray(start, lineEnd));
  return { line, nextOffset: end + 1 };
}

function parseResolutionAxis(
  axisStr: string,
  countStr: string
): { axis: AxisDirection; count: number } {
  if (!['+X', '-X', '+Y', '-Y'].includes(axisStr)) {
    throw new HdrImportError(
      'hdr-dimensions-invalid',
      `Unsupported resolution axis token: "${axisStr}".`
    );
  }
  if (!/^\d+$/.test(countStr)) {
    throw new HdrImportError(
      'hdr-dimensions-invalid',
      `Resolution dimension must be a positive decimal integer: "${countStr}".`
    );
  }
  const count = Number.parseInt(countStr, 10);
  if (count <= 0 || count > HDR_LIMITS.MAX_DIMENSION) {
    throw new HdrImportError(
      'hdr-limit-exceeded',
      `Dimension ${count} exceeds limit of ${HDR_LIMITS.MAX_DIMENSION}.`
    );
  }
  return { axis: axisStr as AxisDirection, count };
}

function parseHdrHeader(bytes: Uint8Array): HeaderParseResult {
  if (bytes.byteLength > HDR_LIMITS.MAX_SOURCE_BYTES) {
    throw new HdrImportError(
      'hdr-limit-exceeded',
      `Source bytes ${bytes.byteLength} exceed limit of ${HDR_LIMITS.MAX_SOURCE_BYTES}.`
    );
  }

  const headerLimit = Math.min(bytes.byteLength, HDR_LIMITS.MAX_HEADER_BYTES);
  let offset = 0;

  // 1. Magic signature
  const { line: magicLine, nextOffset } = parseHeaderLine(bytes, offset, headerLimit);
  offset = nextOffset;
  if (!HDR_MAGIC_SIGNATURES.some((sig) => magicLine === sig)) {
    throw new HdrImportError(
      'hdr-header-invalid',
      `Invalid HDR magic signature: "${magicLine}". Expected #?RADIANCE or #?RGBE.`,
      { byteOffset: 0 }
    );
  }

  let format: string | undefined;
  let exposure: number | undefined;
  let gamma: number | undefined;
  let colorCorr: [number, number, number] | undefined;
  let primaries: [number, number, number, number, number, number, number, number] | undefined;

  // 2. Header records until blank line
  while (offset < headerLimit) {
    const { line, nextOffset: newOffset } = parseHeaderLine(bytes, offset, headerLimit);
    offset = newOffset;
    if (line.trim() === '') {
      break;
    }

    if (line.startsWith('FORMAT=')) {
      if (format !== undefined) {
        throw new HdrImportError(
          'hdr-header-invalid',
          'Conflicting multiple FORMAT declarations in header.',
          { byteOffset: offset }
        );
      }
      if (line !== HDR_REQUIRED_FORMAT) {
        throw new HdrImportError(
          'hdr-header-invalid',
          `Unsupported format declaration "${line}". Must be ${HDR_REQUIRED_FORMAT}.`,
          { byteOffset: offset }
        );
      }
      format = line;
    } else if (line.startsWith('EXPOSURE=')) {
      const expVal = Number.parseFloat(line.slice(9));
      if (!Number.isFinite(expVal) || expVal <= 0) {
        throw new HdrImportError('hdr-header-invalid', `Invalid EXPOSURE value: "${line}".`, {
          byteOffset: offset
        });
      }
      exposure = (exposure ?? 1.0) * expVal;
    } else if (line.startsWith('GAMMA=')) {
      const gamVal = Number.parseFloat(line.slice(6));
      if (!Number.isFinite(gamVal) || gamVal <= 0) {
        throw new HdrImportError('hdr-header-invalid', `Invalid GAMMA value: "${line}".`, {
          byteOffset: offset
        });
      }
      gamma = gamVal;
    }
  }

  if (format === undefined) {
    throw new HdrImportError(
      'hdr-header-invalid',
      'Missing required FORMAT=32-bit_rle_rgbe header.'
    );
  }

  // 3. Resolution line
  const { line: resLine, nextOffset: dataOffset } = parseHeaderLine(bytes, offset, headerLimit);
  const parts = resLine.trim().split(/\s+/);
  if (parts.length !== 4) {
    throw new HdrImportError(
      'hdr-dimensions-invalid',
      `Malformed resolution line: "${resLine}". Expected 4 tokens.`
    );
  }

  const first = parseResolutionAxis(parts[0]!, parts[1]!);
  const second = parseResolutionAxis(parts[2]!, parts[3]!);

  const isFirstX = first.axis === '+X' || first.axis === '-X';
  const isSecondX = second.axis === '+X' || second.axis === '-X';
  if (isFirstX === isSecondX) {
    throw new HdrImportError(
      'hdr-dimensions-invalid',
      `Resolution line must have one X and one Y axis: "${resLine}".`
    );
  }

  const canonicalWidth = isFirstX ? first.count : second.count;
  const canonicalHeight = isFirstX ? second.count : first.count;

  const totalPixels = canonicalWidth * canonicalHeight;
  if (totalPixels > HDR_LIMITS.MAX_PIXELS) {
    throw new HdrImportError(
      'hdr-limit-exceeded',
      `Total pixels ${totalPixels} exceed limit ${HDR_LIMITS.MAX_PIXELS}.`
    );
  }

  return {
    metadata: {
      format,
      exposure,
      gamma,
      colorCorr,
      primaries,
      rawHeaderBytes: dataOffset
    },
    resolution: {
      outerAxis: first.axis,
      outerCount: first.count,
      innerAxis: second.axis,
      innerCount: second.count,
      canonicalWidth,
      canonicalHeight
    },
    dataOffset
  };
}

function decodeScanlineModernRle(
  bytes: Uint8Array,
  startOffset: number,
  scanlineLength: number
): { r: Uint8Array; g: Uint8Array; b: Uint8Array; e: Uint8Array; nextOffset: number } {
  let offset = startOffset;
  const planes = [
    new Uint8Array(scanlineLength),
    new Uint8Array(scanlineLength),
    new Uint8Array(scanlineLength),
    new Uint8Array(scanlineLength)
  ];

  for (let planeIdx = 0; planeIdx < 4; planeIdx++) {
    const plane = planes[planeIdx]!;
    let planeOffset = 0;

    while (planeOffset < scanlineLength) {
      if (offset >= bytes.byteLength) {
        throw new HdrImportError('hdr-truncated', 'Unexpected end of buffer in RLE plane.', {
          byteOffset: offset
        });
      }

      const code = bytes[offset++]!;
      if (code === 0) {
        throw new HdrImportError('hdr-rle-invalid', 'Invalid RLE run length code 0.', {
          byteOffset: offset - 1
        });
      }

      if (code > 128) {
        // Run of repeated bytes
        const count = code - 128;
        if (planeOffset + count > scanlineLength) {
          throw new HdrImportError(
            'hdr-rle-invalid',
            `RLE repeat run of ${count} exceeds scanline plane bounds.`,
            { byteOffset: offset }
          );
        }
        if (offset >= bytes.byteLength) {
          throw new HdrImportError('hdr-truncated', 'Missing repeat byte value in RLE run.', {
            byteOffset: offset
          });
        }
        const val = bytes[offset++]!;
        plane.fill(val, planeOffset, planeOffset + count);
        planeOffset += count;
      } else {
        // Literal bytes
        const count = code;
        if (planeOffset + count > scanlineLength) {
          throw new HdrImportError(
            'hdr-rle-invalid',
            `RLE literal run of ${count} exceeds scanline plane bounds.`,
            { byteOffset: offset }
          );
        }
        if (offset + count > bytes.byteLength) {
          throw new HdrImportError('hdr-truncated', 'Buffer truncated during literal run read.', {
            byteOffset: offset
          });
        }
        plane.set(bytes.subarray(offset, offset + count), planeOffset);
        offset += count;
        planeOffset += count;
      }
    }
  }

  return {
    r: planes[0]!,
    g: planes[1]!,
    b: planes[2]!,
    e: planes[3]!,
    nextOffset: offset
  };
}

export function parseRadianceRgbe(
  bytes: Uint8Array,
  options: HdrImportOptions = {}
): CanonicalHdrPanorama {
  const { metadata, resolution, dataOffset } = parseHdrHeader(bytes);

  // Validate projection policy: require 2:1 ratio for equirectangular panoramas
  if (options.projection !== 'none') {
    if (resolution.canonicalWidth !== 2 * resolution.canonicalHeight) {
      throw new HdrImportError(
        'environment-projection-unsupported',
        `Equirectangular panorama requires 2:1 aspect ratio, got ${resolution.canonicalWidth}x${resolution.canonicalHeight}.`
      );
    }
  }

  const { outerCount, innerCount, outerAxis, innerAxis, canonicalWidth, canonicalHeight } =
    resolution;
  const canonicalPixels = new Float32Array(canonicalWidth * canonicalHeight * 3);

  let offset = dataOffset;
  let isModernRle: boolean | undefined;

  for (let outer = 0; outer < outerCount; outer++) {
    if (offset + 4 > bytes.byteLength) {
      throw new HdrImportError('hdr-truncated', `Scanline ${outer} truncated before marker.`, {
        byteOffset: offset,
        scanline: outer
      });
    }

    const b0 = bytes[offset]!;
    const b1 = bytes[offset + 1]!;
    const b2 = bytes[offset + 2]!;
    const b3 = bytes[offset + 3]!;

    if (isModernRle === undefined) {
      const isEligible =
        innerCount >= HDR_LIMITS.MIN_RLE_SCANLINE_LENGTH &&
        innerCount <= HDR_LIMITS.MAX_RLE_SCANLINE_LENGTH;
      if (b0 === 2 && b1 === 2 && (b2 & 0x80) === 0 && isEligible) {
        const declaredLen = (b2 << 8) | b3;
        if (declaredLen !== innerCount) {
          throw new HdrImportError(
            'hdr-rle-invalid',
            `Modern RLE declared scanline length ${declaredLen} does not match inner count ${innerCount}.`,
            { byteOffset: offset, scanline: outer }
          );
        }
        isModernRle = true;
      } else {
        isModernRle = false;
      }
    }

    if (isModernRle) {
      if (b0 !== 2 || b1 !== 2 || (b2 & 0x80) !== 0 || ((b2 << 8) | b3) !== innerCount) {
        throw new HdrImportError(
          'hdr-rle-invalid',
          `Invalid modern RLE scanline header at scanline ${outer}.`,
          { byteOffset: offset, scanline: outer }
        );
      }
      offset += 4;
      const { r, g, b, e, nextOffset } = decodeScanlineModernRle(bytes, offset, innerCount);
      offset = nextOffset;

      for (let inner = 0; inner < innerCount; inner++) {
        writeCanonicalPixel(
          canonicalPixels,
          r[inner]!,
          g[inner]!,
          b[inner]!,
          e[inner]!,
          outer,
          inner,
          outerAxis,
          innerAxis,
          canonicalWidth,
          canonicalHeight
        );
      }
    } else {
      // Flat 4-byte RGBE mode
      for (let inner = 0; inner < innerCount; inner++) {
        if (offset + 4 > bytes.byteLength) {
          throw new HdrImportError('hdr-truncated', 'Buffer truncated during flat scanline read.', {
            byteOffset: offset,
            scanline: outer
          });
        }
        const pr = bytes[offset]!;
        const pg = bytes[offset + 1]!;
        const pb = bytes[offset + 2]!;
        const pe = bytes[offset + 3]!;
        offset += 4;

        // Strictly reject legacy 1,1,1,count repeat encoding in flat mode
        if (pr === 1 && pg === 1 && pb === 1) {
          throw new HdrImportError(
            'hdr-legacy-rle-unsupported',
            'Legacy 1,1,1,count RLE encoding is unsupported.',
            { byteOffset: offset - 4, scanline: outer }
          );
        }

        writeCanonicalPixel(
          canonicalPixels,
          pr,
          pg,
          pb,
          pe,
          outer,
          inner,
          outerAxis,
          innerAxis,
          canonicalWidth,
          canonicalHeight
        );
      }
    }
  }

  // Reject unexpected trailing bytes
  if (offset < bytes.byteLength) {
    const trailing = bytes.subarray(offset);
    const nonWhitespace = trailing.some(
      (b) => b !== 0x0a && b !== 0x0d && b !== 0x20 && b !== 0x00
    );
    if (nonWhitespace) {
      throw new HdrImportError(
        'hdr-truncated',
        `Extraneous trailing payload of ${bytes.byteLength - offset} bytes found after image.`,
        { byteOffset: offset }
      );
    }
  }

  return {
    width: canonicalWidth,
    height: canonicalHeight,
    pixels: canonicalPixels,
    metadata
  };
}

function writeCanonicalPixel(
  out: Float32Array,
  rByte: number,
  gByte: number,
  bByte: number,
  eByte: number,
  outer: number,
  inner: number,
  outerAxis: AxisDirection,
  innerAxis: AxisDirection,
  width: number,
  height: number
): void {
  // Decode Float32 RGB: channel * 2^(E - 136)
  let r = 0;
  let g = 0;
  let b = 0;

  if (eByte !== 0) {
    const scale = Math.pow(2.0, eByte - 136);
    r = rByte * scale;
    g = gByte * scale;
    b = bByte * scale;
  }

  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
    throw new HdrImportError('environment-nonfinite', 'Decoded non-finite RGB value.');
  }

  if (
    r > HDR_LIMITS.MAX_FLOAT16_FINITE ||
    g > HDR_LIMITS.MAX_FLOAT16_FINITE ||
    b > HDR_LIMITS.MAX_FLOAT16_FINITE
  ) {
    throw new HdrImportError(
      'environment-half-overflow',
      `Decoded RGB (${r}, ${g}, ${b}) exceeds IEEE 754 binary16 maximum finite value 65504.`
    );
  }

  // Map outer / inner coordinates to canonical (x, y)
  let x = 0;
  let y = 0;

  if (outerAxis === '-Y') {
    y = outer;
  } else if (outerAxis === '+Y') {
    y = height - 1 - outer;
  } else if (outerAxis === '+X') {
    x = outer;
  } else if (outerAxis === '-X') {
    x = width - 1 - outer;
  }

  if (innerAxis === '+X') {
    x = inner;
  } else if (innerAxis === '-X') {
    x = width - 1 - inner;
  } else if (innerAxis === '-Y') {
    y = inner;
  } else if (innerAxis === '+Y') {
    y = height - 1 - inner;
  }

  const dstIdx = (y * width + x) * 3;
  out[dstIdx] = r;
  out[dstIdx + 1] = g;
  out[dstIdx + 2] = b;
}
