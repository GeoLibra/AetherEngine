import type { FormatCapabilities, RHILimits } from '../capability-types';
import type { GPUTextureFormat } from '../webgpu-types';
import type { WebGL2BindingManifestEntry } from './shader-types';

export type WebGL2NativeLimits = RHILimits;

export interface WebGL2NativeContextInfo {
  readonly name: string;
  readonly vendor?: string;
  readonly renderer?: string;
}

export interface WebGL2NativeContextLostInfo {
  readonly reason?: string;
  readonly message?: string;
}

export type WebGL2NativeObject = object;

export interface WebGL2NativeContextPort {
  readonly info: WebGL2NativeContextInfo;
  readonly extensions: ReadonlySet<string>;
  readonly limits: WebGL2NativeLimits;
  readonly formats: ReadonlyMap<GPUTextureFormat, FormatCapabilities>;
  readonly precision: Readonly<Record<string, number>>;
  readonly lost: Promise<WebGL2NativeContextLostInfo>;
  createBuffer?(descriptor: Readonly<Record<string, unknown>>): WebGL2NativeObject;
  createTexture?(descriptor: Readonly<Record<string, unknown>>): WebGL2NativeObject;
  createSampler?(descriptor: Readonly<Record<string, unknown>>): WebGL2NativeObject;
  createProgram?(descriptor: Readonly<Record<string, unknown>>): WebGL2NativeObject;
  getProgramReflection?(program: WebGL2NativeObject): readonly WebGL2BindingManifestEntry[];
  deleteBuffer?(handle: WebGL2NativeObject): void;
  deleteTexture?(handle: WebGL2NativeObject): void;
  deleteSampler?(handle: WebGL2NativeObject): void;
  deleteProgram?(handle: WebGL2NativeObject): void;
  writeBuffer?(handle: WebGL2NativeObject, offset: number, data: ArrayBufferView): void;
  writeTexture?(
    destination: Readonly<Record<string, unknown>>,
    data: ArrayBufferView,
    dataLayout: Readonly<Record<string, number | undefined>>,
    size: Readonly<Record<string, number>>
  ): void;
  destroy?(): void;
}

export interface WebGL2AdapterFacts {
  readonly extensions: ReadonlySet<string>;
  readonly precision: Readonly<Record<string, number>>;
}
