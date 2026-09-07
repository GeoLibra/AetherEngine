/**
 * @file IEEE 754 binary16 (half-precision float16) packing and RGBA16F binary payload encoders.
 * Strictly clamps within [0, 65504] and stores contiguous little-endian bytes.
 */

const FLOAT32_VIEW = new Float32Array(1);
const UINT32_VIEW = new Uint32Array(FLOAT32_VIEW.buffer);

/**
 * Converts a Float32 number to an IEEE 754 binary16 unsigned 16-bit integer.
 * Invariant: Nonnegative clamped in [0, 65504], round ties to even.
 */
export function float32ToFloat16(val: number): number {
  if (val <= 0) return 0;
  if (val > 65504.0) {
    throw new Error(`Float16 overflow: value ${val} exceeds maximum finite 65504.`);
  }

  FLOAT32_VIEW[0] = val;
  const f32Bits = UINT32_VIEW[0]!;

  const sign = (f32Bits >>> 31) & 0x1;
  let exp = (f32Bits >>> 23) & 0xff;
  let mant = f32Bits & 0x7fffff;

  if (exp === 0) {
    return sign << 15; // zero
  }

  // Rebasing exponent from 127 to 15
  const newExp = exp - 127 + 15;

  if (newExp >= 31) {
    // Overflow -> clamp to max finite (exp 30, mantissa all 1s)
    return (sign << 15) | (30 << 10) | 0x3ff;
  }

  if (newExp <= 0) {
    // Underflow -> denormalized or zero
    if (newExp < -10) {
      return sign << 15;
    }
    mant = (mant | 0x800000) >> (1 - newExp);
    return (sign << 15) | (mant >> 13);
  }

  // Round to nearest even
  const roundBit = (mant >>> 12) & 1;
  let hMant = mant >>> 13;
  if (roundBit && ((mant & 0xfff) !== 0 || (hMant & 1) !== 0)) {
    hMant += 1;
    if (hMant > 0x3ff) {
      hMant = 0;
      return (sign << 15) | ((newExp + 1) << 10);
    }
  }

  return (sign << 15) | (newExp << 10) | hMant;
}

/**
 * Converts an IEEE 754 binary16 unsigned 16-bit integer to a JavaScript Float32 number.
 */
export function float16ToFloat32(h: number): number {
  const sign = (h >>> 15) & 0x1;
  const exp = (h >>> 10) & 0x1f;
  const mant = h & 0x3ff;

  if (exp === 0) {
    if (mant === 0) return sign ? -0.0 : 0.0;
    // Denormalized
    const val = (mant / 1024.0) * Math.pow(2, -14);
    return sign ? -val : val;
  }

  if (exp === 31) {
    return mant === 0 ? (sign ? -Infinity : Infinity) : NaN;
  }

  const val = (1.0 + mant / 1024.0) * Math.pow(2, exp - 15);
  return sign ? -val : val;
}

/**
 * Packs 3-channel RGB Float32 pixel buffer into tightly packed little-endian RGBA16F bytes (alpha = 1.0).
 */
export function packRgbToRgba16Float(
  rgbPixels: Float32Array,
  width: number,
  height: number
): Uint8Array {
  const pixelCount = width * height;
  if (rgbPixels.length < pixelCount * 3) {
    throw new Error(
      `Insufficient RGB pixels: expected ${pixelCount * 3}, got ${rgbPixels.length}.`
    );
  }

  const outBytes = new Uint8Array(pixelCount * 8); // 8 bytes per RGBA16F texel
  const dataView = new DataView(outBytes.buffer, outBytes.byteOffset, outBytes.byteLength);

  // 1.0 in Float16 is 0x3c00 (sign=0, exp=15, mant=0)
  const alphaHalf = 0x3c00;

  for (let i = 0; i < pixelCount; i++) {
    const srcOffset = i * 3;
    const dstOffset = i * 8;

    const r = float32ToFloat16(rgbPixels[srcOffset]!);
    const g = float32ToFloat16(rgbPixels[srcOffset + 1]!);
    const b = float32ToFloat16(rgbPixels[srcOffset + 2]!);

    dataView.setUint16(dstOffset, r, true);
    dataView.setUint16(dstOffset + 2, g, true);
    dataView.setUint16(dstOffset + 4, b, true);
    dataView.setUint16(dstOffset + 6, alphaHalf, true);
  }

  return outBytes;
}

/**
 * Packs 4-channel RGBA Float32 pixel buffer into tightly packed little-endian RGBA16F bytes.
 */
export function packRgbaToRgba16Float(
  rgbaPixels: Float32Array,
  width: number,
  height: number
): Uint8Array {
  const pixelCount = width * height;
  if (rgbaPixels.length < pixelCount * 4) {
    throw new Error(
      `Insufficient RGBA pixels: expected ${pixelCount * 4}, got ${rgbaPixels.length}.`
    );
  }

  const outBytes = new Uint8Array(pixelCount * 8);
  const dataView = new DataView(outBytes.buffer, outBytes.byteOffset, outBytes.byteLength);

  for (let i = 0; i < pixelCount; i++) {
    const srcOffset = i * 4;
    const dstOffset = i * 8;

    const r = float32ToFloat16(rgbaPixels[srcOffset]!);
    const g = float32ToFloat16(rgbaPixels[srcOffset + 1]!);
    const b = float32ToFloat16(rgbaPixels[srcOffset + 2]!);
    const a = float32ToFloat16(rgbaPixels[srcOffset + 3]!);

    dataView.setUint16(dstOffset, r, true);
    dataView.setUint16(dstOffset + 2, g, true);
    dataView.setUint16(dstOffset + 4, b, true);
    dataView.setUint16(dstOffset + 6, a, true);
  }

  return outBytes;
}

/**
 * Decodes RGBA16F little-endian bytes back into a Float32Array (4 components per texel).
 */
export function unpackRgba16Float(bytes: Uint8Array, width: number, height: number): Float32Array {
  const pixelCount = width * height;
  if (bytes.byteLength < pixelCount * 8) {
    throw new Error(`Insufficient bytes: expected ${pixelCount * 8}, got ${bytes.byteLength}.`);
  }

  const out = new Float32Array(pixelCount * 4);
  const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  for (let i = 0; i < pixelCount; i++) {
    const srcOffset = i * 8;
    const dstOffset = i * 4;

    out[dstOffset] = float16ToFloat32(dataView.getUint16(srcOffset, true));
    out[dstOffset + 1] = float16ToFloat32(dataView.getUint16(srcOffset + 2, true));
    out[dstOffset + 2] = float16ToFloat32(dataView.getUint16(srcOffset + 4, true));
    out[dstOffset + 3] = float16ToFloat32(dataView.getUint16(srcOffset + 6, true));
  }

  return out;
}
