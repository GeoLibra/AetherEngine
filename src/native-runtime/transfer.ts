import type {
  NativeTransferLease,
  NativeTransferMode,
  NativeTransferPort,
  NativeTransferReleaseReason,
  NativeTransferState,
  NativeTransferView
} from './handle-types';

export class NativeTransferCapabilityError extends Error {
  constructor(readonly mode: Exclude<NativeTransferMode, 'copy'>) {
    super(`Native ArrayBuffer transfer mode "${mode}" is not supported.`);
    this.name = 'NativeTransferCapabilityError';
  }
}

export function createNativeTransfer(
  data: ArrayBuffer,
  mode: NativeTransferMode,
  port: NativeTransferPort
): NativeTransferLease {
  assertTransferCapability(mode, port);
  return new TransferLease(data, mode, port);
}

class TransferLease implements NativeTransferLease {
  readonly id: number;
  readonly owner: string;
  private bytes: Uint8Array | undefined;
  private currentState: NativeTransferState = 'active';
  private readonly transferView: NativeTransferView;

  constructor(
    data: ArrayBuffer,
    readonly mode: NativeTransferMode,
    private readonly port: NativeTransferPort
  ) {
    this.id = port.allocateId();
    if (!Number.isSafeInteger(this.id) || this.id < 0) {
      throw new Error('Native transfer id must be a non-negative safe integer.');
    }
    this.owner = port.owner;
    const backing = mode === 'copy'
      ? data.slice(0)
      : mode === 'transfer'
        ? port.takeOwnership(data)
        : data;
    this.bytes = new Uint8Array(backing);
    const thisLease = this;
    // Expose checked operations instead of a backing view that could outlive settlement.
    this.transferView = Object.freeze({
      get byteLength(): number { return thisLease.requireBytes().byteLength; },
      read: (index: number): number => this.read(index),
      copyBytes: (): Uint8Array => new Uint8Array(this.requireBytes())
    });
  }

  get state(): NativeTransferState { return this.currentState; }

  get view(): NativeTransferView {
    this.requireBytes();
    return this.transferView;
  }

  settle(): boolean { return this.finish('settled'); }

  cancel(): boolean { return this.finish('cancelled'); }

  finalize(): boolean { return this.finish('cancelled'); }

  private read(index: number): number {
    const bytes = this.requireBytes();
    if (!Number.isInteger(index) || index < 0 || index >= bytes.byteLength) {
      throw new RangeError(`Native transfer byte index ${index} is out of bounds.`);
    }
    return bytes[index]!;
  }

  private finish(reason: NativeTransferReleaseReason): boolean {
    if (this.currentState !== 'active') return false;
    this.currentState = reason;
    this.bytes = undefined;
    this.port.release(this.id, reason);
    return true;
  }

  private requireBytes(): Uint8Array {
    if (this.bytes === undefined) {
      throw new Error(`Native transfer is ${this.currentState}; backing access is inactive.`);
    }
    return this.bytes;
  }
}

function assertTransferCapability(mode: NativeTransferMode, port: NativeTransferPort): void {
  if (mode === 'copy') return;
  if (!port.capabilities[mode]) throw new NativeTransferCapabilityError(mode);
}
