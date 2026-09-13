import type { AssetImportBudget } from './types';

export interface StandardBudgetOptions {
  readonly maxSizeBytes?: number;
  readonly maxAllocationBytes?: number;
  readonly timeoutMs?: number;
}

/**
 * Tracks read and allocated bytes against defined ceilings during import.
 */
export class StandardImportBudget implements AssetImportBudget {
  readonly maxSizeBytes: number;
  readonly maxAllocationBytes: number;
  readonly timeoutMs: number;

  private currentAllocatedBytes = 0;
  private currentReadBytes = 0;

  constructor(options: StandardBudgetOptions = {}) {
    this.maxSizeBytes = options.maxSizeBytes ?? 256 * 1024 * 1024; // 256 MB default
    this.maxAllocationBytes = options.maxAllocationBytes ?? 512 * 1024 * 1024; // 512 MB default
    this.timeoutMs = options.timeoutMs ?? 30000; // 30s default
  }

  checkAllocated(bytes: number): void {
    this.currentAllocatedBytes += bytes;
    if (this.currentAllocatedBytes > this.maxAllocationBytes) {
      throw new Error(
        `Asset import allocation budget exceeded: allocated ${this.currentAllocatedBytes} bytes (limit ${this.maxAllocationBytes} bytes).`
      );
    }
  }

  recordRead(bytes: number): void {
    this.currentReadBytes += bytes;
    if (this.currentReadBytes > this.maxSizeBytes) {
      throw new Error(
        `Asset import size budget exceeded: read ${this.currentReadBytes} bytes (limit ${this.maxSizeBytes} bytes).`
      );
    }
  }

  getAllocatedBytes(): number {
    return this.currentAllocatedBytes;
  }

  getReadBytes(): number {
    return this.currentReadBytes;
  }
}
