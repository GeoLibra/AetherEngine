import type { NativeAbiExpectation } from './manifest-types';

export interface NativeHandshakeModule {
  readonly name: string;
  readonly version: number;
}

export interface NativeHandshake {
  readonly buildId: string;
  readonly engineAbiVersion: number;
  readonly rhiContractVersion: number;
  readonly modules: readonly NativeHandshakeModule[];
  readonly abi: NativeAbiExpectation;
}

export type NativeHandshakeDifference =
  | { readonly kind: 'build-id'; readonly required: string; readonly actual: string }
  | { readonly kind: 'engine-abi'; readonly required: number; readonly actual: number }
  | { readonly kind: 'rhi-contract'; readonly required: number; readonly actual: number }
  | {
      readonly kind: 'endianness';
      readonly required: 'little' | 'big';
      readonly actual: 'little' | 'big';
    }
  | { readonly kind: 'pointer-bits'; readonly required: 32 | 64; readonly actual: 32 | 64 }
  | {
      readonly kind: 'array-buffer';
      readonly capability: 'transfer' | 'mapped' | 'shared';
      readonly required: true;
      readonly actual: boolean;
    }
  | {
      readonly kind: 'module';
      readonly module: string;
      readonly required: number;
      readonly actual: number | undefined;
    };

export type NativeNegotiatedHandshake = NativeHandshake;
