export declare const nativeHandleType: unique symbol;

export type NativeHandle<T> = Readonly<{
  id: number;
  generation: number;
  owner: string;
  [nativeHandleType]?: T;
}>;

export interface NativeHandleRegistryOptions<T> {
  readonly owner: string;
  readonly destroy: (value: T) => void;
}

export interface NativeHandleLease<T> {
  readonly value: T;
  release(): boolean;
}

export type NativeTransferMode = 'copy' | 'transfer' | 'mapped' | 'shared';
export type NativeTransferState = 'active' | 'settled' | 'cancelled';
export type NativeTransferReleaseReason = Exclude<NativeTransferState, 'active'>;

export interface NativeTransferPort {
  readonly owner: string;
  readonly capabilities: Readonly<{
    transfer: boolean;
    mapped: boolean;
    shared: boolean;
  }>;
  allocateId(): number;
  takeOwnership(data: ArrayBuffer): ArrayBuffer;
  release(id: number, reason: NativeTransferReleaseReason): void;
}

export interface NativeTransferView {
  readonly byteLength: number;
  read(index: number): number;
  copyBytes(): Uint8Array;
}

export interface NativeTransferLease {
  readonly id: number;
  readonly mode: NativeTransferMode;
  readonly owner: string;
  readonly state: NativeTransferState;
  readonly view: NativeTransferView;
  settle(): boolean;
  cancel(): boolean;
  finalize(): boolean;
}
