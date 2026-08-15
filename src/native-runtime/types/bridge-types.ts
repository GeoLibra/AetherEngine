import type { NativeNegotiatedHandshake } from './abi-types';
import type { NativeRuntimeController } from '../runtime';

export interface NativeCancellationToken {
  readonly cancelled: boolean;
  subscribe(listener: () => void): () => boolean;
}

export interface NativeMethodDescriptor<I, O> {
  readonly module: string;
  readonly method: string;
  readonly version: number;
  readonly maxRequestBytes: number;
  readonly validateRequest: (value: unknown) => value is I;
  readonly validateResponse: (value: unknown) => value is O;
}

export interface NativeBridgeRequest {
  readonly id: number;
  readonly module: string;
  readonly method: string;
  readonly version: number;
  readonly payload: unknown;
}

export type NativeBridgeResponse =
  | { readonly id: number; readonly ok: true; readonly payload: unknown }
  | { readonly id: number; readonly ok: false; readonly code: string; readonly detail?: string };

export interface NativeBridgeInvocation {
  cancel(): void;
}

export interface NativeBridgePort {
  invoke(
    request: NativeBridgeRequest,
    complete: (response: NativeBridgeResponse) => void
  ): NativeBridgeInvocation;
}

export interface NativeBridgeDispatcherOptions {
  readonly handshake: NativeNegotiatedHandshake;
  readonly runtime: NativeRuntimeController;
  readonly port: NativeBridgePort;
  readonly methods: readonly NativeMethodDescriptor<unknown, unknown>[];
}

export type NativeBridgeErrorCode =
  | 'cancelled'
  | 'invalid-request'
  | 'request-too-large'
  | 'unknown-method'
  | 'native-failure'
  | 'invalid-response'
  | 'runtime-unavailable';
