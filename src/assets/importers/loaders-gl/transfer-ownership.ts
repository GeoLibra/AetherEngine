/**
 * Tracks byte-level transfer and copy statistics during asset ingestion.
 */
export class OwnershipTransferTracker {
  private _copiedBytes = 0;
  private _zeroCopyBytes = 0;

  get copiedBytes(): number {
    return this._copiedBytes;
  }

  get zeroCopyBytes(): number {
    return this._zeroCopyBytes;
  }

  recordCopy(bytes: number): void {
    this._copiedBytes += bytes;
  }

  recordZeroCopy(bytes: number): void {
    this._zeroCopyBytes += bytes;
  }

  /**
   * Allocates and copies a freshly isolated typed array from caller-owned buffers,
   * guaranteeing engine ownership and immutability.
   */
  obtainTypedArray<T extends TypedArray>(
    Constructor: new (length: number) => T,
    buffer: ArrayBufferLike,
    byteOffset: number,
    length: number
  ): T {
    const elementSize = (Constructor as any).BYTES_PER_ELEMENT ?? 1;
    const byteLength = length * elementSize;
    const copy = new Constructor(length);
    const srcView = new Uint8Array(buffer, byteOffset, byteLength);
    new Uint8Array(copy.buffer).set(srcView);
    this.recordCopy(byteLength);
    return copy;
  }
}

type TypedArray =
  | Uint8Array
  | Uint16Array
  | Uint32Array
  | Int8Array
  | Int16Array
  | Int32Array
  | Float32Array
  | Float64Array;
