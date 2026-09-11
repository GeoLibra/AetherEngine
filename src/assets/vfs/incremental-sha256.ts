/**
 * @file Bounded memory incremental SHA-256 hash calculator conforming to FIPS 180-4.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

const HEX = Array.from({ length: 256 }, (_, index) => index.toString(16).padStart(2, '0'));

/**
 * Incremental SHA-256 hasher with O(1) memory consumption.
 * Buffers at most 64 bytes of uncompressed input.
 */
export class IncrementalSha256 {
  private h0 = 0x6a09e667;
  private h1 = 0xbb67ae85;
  private h2 = 0x3c6ef372;
  private h3 = 0xa54ff53a;
  private h4 = 0x510e527f;
  private h5 = 0x9b05688c;
  private h6 = 0x1f83d9ab;
  private h7 = 0x5be0cd19;

  private readonly block = new Uint8Array(64);
  private blockLength = 0;
  private totalBytes = 0;
  private finalized = false;
  private readonly w = new Uint32Array(64);

  /** Feeds a chunk of bytes into the hasher. */
  public update(chunk: Uint8Array): this {
    if (this.finalized) {
      throw new Error('IncrementalSha256: cannot update after digest() has been called.');
    }
    const len = chunk.byteLength;
    if (len === 0) return this;

    this.totalBytes += len;
    let offset = 0;

    // Fill partial block if present
    if (this.blockLength > 0) {
      const needed = 64 - this.blockLength;
      const toCopy = Math.min(needed, len);
      this.block.set(chunk.subarray(0, toCopy), this.blockLength);
      this.blockLength += toCopy;
      offset += toCopy;

      if (this.blockLength === 64) {
        this.processBlock(this.block, 0);
        this.blockLength = 0;
      }
    }

    // Process full 64-byte blocks directly from chunk without intermediate copy
    while (offset + 64 <= len) {
      this.processBlock(chunk, offset);
      offset += 64;
    }

    // Retain remaining bytes in block buffer
    if (offset < len) {
      const remaining = len - offset;
      this.block.set(chunk.subarray(offset), 0);
      this.blockLength = remaining;
    }

    return this;
  }

  /** Finalizes the hash calculation and returns the hex-encoded digest string. */
  public digest(): string {
    if (this.finalized) {
      throw new Error('IncrementalSha256: digest() has already been called.');
    }
    this.finalized = true;

    // Append 0x80 padding byte
    this.block[this.blockLength] = 0x80;
    this.blockLength += 1;

    // If less than 8 bytes remaining for 64-bit length, pad and process block
    if (this.blockLength > 56) {
      this.block.fill(0, this.blockLength, 64);
      this.processBlock(this.block, 0);
      this.blockLength = 0;
    }

    // Pad with zeros up to 56 bytes
    this.block.fill(0, this.blockLength, 56);

    // Append 64-bit length in bits (big-endian)
    const totalBits = BigInt(this.totalBytes) * 8n;
    const highBits = Number((totalBits >> 32n) & 0xffffffffn);
    const lowBits = Number(totalBits & 0xffffffffn);

    const view = new DataView(this.block.buffer, this.block.byteOffset, 64);
    view.setUint32(56, highBits, false);
    view.setUint32(60, lowBits, false);

    this.processBlock(this.block, 0);

    return (
      toHex32(this.h0) +
      toHex32(this.h1) +
      toHex32(this.h2) +
      toHex32(this.h3) +
      toHex32(this.h4) +
      toHex32(this.h5) +
      toHex32(this.h6) +
      toHex32(this.h7)
    );
  }

  private processBlock(bytes: Uint8Array, offset: number): void {
    const w = this.w;
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 64);

    for (let index = 0; index < 16; index++) {
      w[index] = view.getUint32(index * 4, false);
    }

    for (let index = 16; index < 64; index++) {
      const s0 = rotr(w[index - 15]!, 7) ^ rotr(w[index - 15]!, 18) ^ (w[index - 15]! >>> 3);
      const s1 = rotr(w[index - 2]!, 17) ^ rotr(w[index - 2]!, 19) ^ (w[index - 2]! >>> 10);
      w[index] = (w[index - 16]! + s0 + w[index - 7]! + s1) | 0;
    }

    let a = this.h0;
    let b = this.h1;
    let c = this.h2;
    let d = this.h3;
    let e = this.h4;
    let f = this.h5;
    let g = this.h6;
    let h = this.h7;

    for (let index = 0; index < 64; index++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + K[index]! + w[index]!) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    this.h0 = (this.h0 + a) | 0;
    this.h1 = (this.h1 + b) | 0;
    this.h2 = (this.h2 + c) | 0;
    this.h3 = (this.h3 + d) | 0;
    this.h4 = (this.h4 + e) | 0;
    this.h5 = (this.h5 + f) | 0;
    this.h6 = (this.h6 + g) | 0;
    this.h7 = (this.h7 + h) | 0;
  }
}

function rotr(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

function toHex32(value: number): string {
  const u32 = value >>> 0;
  const b0 = (u32 >>> 24) & 0xff;
  const b1 = (u32 >>> 16) & 0xff;
  const b2 = (u32 >>> 8) & 0xff;
  const b3 = u32 & 0xff;
  return HEX[b0]! + HEX[b1]! + HEX[b2]! + HEX[b3]!;
}
