import type { FormatCapabilities, RHILimits } from '../capability-types';
import type { GPUTextureFormat } from '../webgpu-types';

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

export interface WebGL2NativeContextPort {
  readonly info: WebGL2NativeContextInfo;
  readonly extensions: ReadonlySet<string>;
  readonly limits: WebGL2NativeLimits;
  readonly formats: ReadonlyMap<GPUTextureFormat, FormatCapabilities>;
  readonly precision: Readonly<Record<string, number>>;
  readonly lost: Promise<WebGL2NativeContextLostInfo>;
  destroy?(): void;
}

export interface WebGL2AdapterFacts {
  readonly extensions: ReadonlySet<string>;
  readonly precision: Readonly<Record<string, number>>;
}
