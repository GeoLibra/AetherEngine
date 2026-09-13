export interface AllocationBudgetCheck {
  checkAllocated(bytes: number): void;
}

/**
 * Tracks byte-level transfer and copy statistics during asset ingestion,
 * and enforces allocation budget limits before memory allocations occur.
 */
export class OwnershipTransferTracker {
  private _copiedBytes = 0;
  private _zeroCopyBytes = 0;

  constructor(private readonly budget?: AllocationBudgetCheck) {}

  get copiedBytes(): number {
    return this._copiedBytes;
  }

  get zeroCopyBytes(): number {
    return this._zeroCopyBytes;
  }

  checkAllocated(bytes: number): void {
    this.budget?.checkAllocated(bytes);
  }

  recordCopy(bytes: number): void {
    this._copiedBytes += bytes;
  }

  recordZeroCopy(bytes: number): void {
    this._zeroCopyBytes += bytes;
  }

  /**
   * Pre-checks budget and allocates a newly isolated typed array, recording copied bytes.
   */
  allocateTypedArray<T extends TypedArray>(
    Constructor: new (length: number) => T,
    length: number
  ): T {
    const elementSize = (Constructor as any).BYTES_PER_ELEMENT ?? 1;
    const byteLength = length * elementSize;
    this.checkAllocated(byteLength);
    this.recordCopy(byteLength);
    return new Constructor(length);
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
    this.checkAllocated(byteLength);
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
