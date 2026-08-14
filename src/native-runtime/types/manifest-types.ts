/** Native deployment targets accepted by the build manifest. */
export type NativePlatform = 'macos' | 'ios' | 'windows' | 'linux' | 'android';
export type NativeJsRuntime = 'jsc' | 'v8' | 'hermes';
export type NativeRuntimeOwnership = 'dedicated' | 'embedded';
export type NativeBridgeKind = 'napi-compatible' | 'engine-adapter' | 'jsi';

export interface NativeTargetConfiguration {
  readonly platform: NativePlatform;
  readonly runtime: NativeJsRuntime;
  readonly ownership: NativeRuntimeOwnership;
  readonly bridge: NativeBridgeKind;
  readonly jitEnabled: boolean;
}

export interface NativeModuleRequirement {
  readonly name: string;
  readonly version: number;
  readonly required: boolean;
}

export interface NativeArrayBufferCapabilities {
  readonly transfer: boolean;
  readonly mapped: boolean;
  readonly shared: boolean;
}

export interface NativeAbiExpectation {
  readonly endianness: 'little' | 'big';
  readonly pointerBits: 32 | 64;
  readonly arrayBuffer: NativeArrayBufferCapabilities;
}

export interface NativeBuildManifest {
  readonly buildId: string;
  readonly engineAbiVersion: number;
  readonly rhiContractVersion: number;
  readonly target: NativeTargetConfiguration;
  readonly modules: readonly NativeModuleRequirement[];
  readonly abi: NativeAbiExpectation;
  readonly sourceFiles: readonly string[];
}

export interface NativeTargetPolicy {
  readonly approvedTargets: readonly NativeTargetConfiguration[];
}
