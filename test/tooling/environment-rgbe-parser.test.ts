import { describe, expect, it } from 'vitest';
import { HdrImportError, parseRadianceRgbe } from '../../tools/asset-cook/environment/decode';

function encodeFlatRgbe(
  width: number,
  height: number,
  pixels: Array<[number, number, number, number]>,
  resolutionLine = `-Y ${height} +X ${width}`
): Uint8Array {
  const header = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n${resolutionLine}\n`;
  const headerBytes = new TextEncoder().encode(header);
  const totalBytes = new Uint8Array(headerBytes.length + width * height * 4);
  totalBytes.set(headerBytes, 0);

  let offset = headerBytes.length;
  for (const [r, g, b, e] of pixels) {
    totalBytes[offset++] = r;
    totalBytes[offset++] = g;
    totalBytes[offset++] = b;
    totalBytes[offset++] = e;
  }
  return totalBytes;
}

function encodeModernRleScanline(r: number[], g: number[], b: number[], e: number[]): number[] {
  const len = r.length;
  const result: number[] = [2, 2, (len >> 8) & 0xff, len & 0xff];

  for (const plane of [r, g, b, e]) {
    // Simple literal encoding for test
    let i = 0;
    while (i < len) {
      const chunk = Math.min(128, len - i);
      result.push(chunk);
      for (let j = 0; j < chunk; j++) {
        result.push(plane[i + j]!);
      }
      i += chunk;
    }
  }
  return result;
}

describe('Radiance RGBE parser', () => {
  it('parses valid flat RGBE image with standard -Y +X axes', () => {
    // 2x1 image -> width=2, height=1 (2:1 aspect ratio)
    const pixels: Array<[number, number, number, number]> = [
      [128, 64, 32, 136], // scale = 2^(136 - 136) = 1.0 => (128, 64, 32)
      [255, 128, 0, 137] // scale = 2^(137 - 136) = 2.0 => (510, 256, 0)
    ];

    const bytes = encodeFlatRgbe(2, 1, pixels);
    const result = parseRadianceRgbe(bytes);

    expect(result.width).toBe(2);
    expect(result.height).toBe(1);
    expect(result.pixels[0]).toBeCloseTo(128.0);
    expect(result.pixels[1]).toBeCloseTo(64.0);
    expect(result.pixels[2]).toBeCloseTo(32.0);
    expect(result.pixels[3]).toBeCloseTo(510.0);
    expect(result.pixels[4]).toBeCloseTo(256.0);
    expect(result.pixels[5]).toBeCloseTo(0.0);
  });

  it('parses modern 4-plane RLE encoded image', () => {
    // 8x4 image (eligible for RLE: length >= 8)
    const width = 8;
    const height = 4;
    const header = `#?RGBE\r\nFORMAT=32-bit_rle_rgbe\r\n\r\n-Y ${height} +X ${width}\r\n`;
    const headerBytes = new TextEncoder().encode(header);

    const scanlines: number[] = [];
    for (let y = 0; y < height; y++) {
      const r = new Array(width).fill(y * 10);
      const g = new Array(width).fill(y * 20);
      const b = new Array(width).fill(y * 30);
      const e = new Array(width).fill(136); // scale 1.0
      scanlines.push(...encodeModernRleScanline(r, g, b, e));
    }

    const total = new Uint8Array(headerBytes.length + scanlines.length);
    total.set(headerBytes, 0);
    total.set(scanlines, headerBytes.length);

    const result = parseRadianceRgbe(total);
    expect(result.width).toBe(8);
    expect(result.height).toBe(4);
    // Row 2 pixel 0
    const row2Offset = (2 * width + 0) * 3;
    expect(result.pixels[row2Offset]).toBeCloseTo(20.0);
    expect(result.pixels[row2Offset + 1]).toBeCloseTo(40.0);
    expect(result.pixels[row2Offset + 2]).toBeCloseTo(60.0);
  });

  it('correctly canonicalizes inverted Y axis (+Y +X)', () => {
    // 2x1 with +Y +X (bottom-to-top): row 0 in stream becomes row 0 in canonical since height=1
    // Let's test 2x2 with projection bypassed
    const pixels: Array<[number, number, number, number]> = [
      [10, 0, 0, 136], // stream row 0 (+Y bottom row) -> canonical row 1
      [10, 0, 0, 136],
      [20, 0, 0, 136], // stream row 1 (+Y top row) -> canonical row 0
      [20, 0, 0, 136]
    ];

    const bytes = encodeFlatRgbe(2, 2, pixels, '+Y 2 +X 2');
    const result = parseRadianceRgbe(bytes, { projection: 'none' });

    expect(result.width).toBe(2);
    expect(result.height).toBe(2);
    // Canonical row 0 should have value 20
    expect(result.pixels[0]).toBeCloseTo(20.0);
    // Canonical row 1 should have value 10
    expect(result.pixels[(2 * 2 * 3) / 2]).toBeCloseTo(10.0);
  });

  it('rejects unsupported legacy 1,1,1,count RLE encoding', () => {
    const pixels: Array<[number, number, number, number]> = [
      [1, 1, 1, 5] // legacy marker
    ];
    const bytes = encodeFlatRgbe(2, 1, pixels);
    expect(() => parseRadianceRgbe(bytes)).toThrow(HdrImportError);
    try {
      parseRadianceRgbe(bytes);
    } catch (err: any) {
      expect(err.code).toBe('hdr-legacy-rle-unsupported');
    }
  });

  it('rejects invalid magic signature', () => {
    const badHeader = new TextEncoder().encode('BAD_MAGIC\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 2\n');
    expect(() => parseRadianceRgbe(badHeader)).toThrow(HdrImportError);
    try {
      parseRadianceRgbe(badHeader);
    } catch (err: any) {
      expect(err.code).toBe('hdr-header-invalid');
    }
  });

  it('rejects non-2:1 aspect ratio when equirectangular projection is declared', () => {
    const bytes = encodeFlatRgbe(3, 1, [
      [1, 2, 3, 136],
      [1, 2, 3, 136],
      [1, 2, 3, 136]
    ]);
    expect(() => parseRadianceRgbe(bytes, { projection: 'equirectangular' })).toThrow(
      HdrImportError
    );
    try {
      parseRadianceRgbe(bytes, { projection: 'equirectangular' });
    } catch (err: any) {
      expect(err.code).toBe('environment-projection-unsupported');
    }
  });

  it('rejects values that overflow binary16 max finite (>65504)', () => {
    // e=153 => 2^(153-136) = 2^17 = 131072, r=1 => 131072 > 65504
    const pixels: Array<[number, number, number, number]> = [
      [1, 0, 0, 153],
      [0, 0, 0, 0]
    ];
    const bytes = encodeFlatRgbe(2, 1, pixels);
    expect(() => parseRadianceRgbe(bytes)).toThrow(HdrImportError);
    try {
      parseRadianceRgbe(bytes);
    } catch (err: any) {
      expect(err.code).toBe('environment-half-overflow');
    }
  });

  it('rejects truncated RLE scanlines', () => {
    const header = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 4 +X 8\n`;
    const headerBytes = new TextEncoder().encode(header);
    // Truncated scanline marker
    const corrupted = new Uint8Array([...headerBytes, 2, 2, 0]);
    expect(() => parseRadianceRgbe(corrupted)).toThrow(HdrImportError);
    try {
      parseRadianceRgbe(corrupted);
    } catch (err: any) {
      expect(err.code).toBe('hdr-truncated');
    }
  });
});
