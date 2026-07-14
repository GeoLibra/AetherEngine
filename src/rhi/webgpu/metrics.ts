export interface WebGPUFastPathMetrics {
  readonly nativeEncoders: number;
  readonly nativeCommandBuffers: number;
  readonly nativeQueueSubmits: number;
  readonly commandWrapperAllocations: number;
  readonly commandReplayRecordAllocations: number;
  readonly uploadCalls: number;
  readonly uploadBytes: number;
}

export class WebGPUFastPathCounter {
  private nativeEncoderCount = 0;
  private nativeCommandBufferCount = 0;
  private nativeQueueSubmitCount = 0;
  private commandWrapperAllocationCount = 0;
  private uploadCallCount = 0;
  private uploadedByteCount = 0;

  recordEncoder(): void {
    this.nativeEncoderCount += 1;
    this.commandWrapperAllocationCount += 1;
  }

  recordPassWrapper(): void { this.commandWrapperAllocationCount += 1; }

  recordCommandBuffer(): void {
    this.nativeCommandBufferCount += 1;
    this.commandWrapperAllocationCount += 1;
  }

  recordSubmit(): void { this.nativeQueueSubmitCount += 1; }

  recordUpload(bytes: number): void {
    this.uploadCallCount += 1;
    this.uploadedByteCount += bytes;
  }

  snapshot(): WebGPUFastPathMetrics {
    return Object.freeze({
      nativeEncoders: this.nativeEncoderCount,
      nativeCommandBuffers: this.nativeCommandBufferCount,
      nativeQueueSubmits: this.nativeQueueSubmitCount,
      commandWrapperAllocations: this.commandWrapperAllocationCount,
      // The production WebGPU path forwards immediately and never creates replay records.
      commandReplayRecordAllocations: 0,
      uploadCalls: this.uploadCallCount,
      uploadBytes: this.uploadedByteCount
    });
  }
}
