export type ShaderLayoutPolicyId = 'wgsl-uniform' | 'wgsl-storage' | 'glsl-std140';
export type ShaderTarget = 'wgsl' | 'glsl300es';
export type ShaderScalarKind = 'f32' | 'i32' | 'u32' | 'bool32';
export type ShaderStage = 'vertex' | 'fragment' | 'compute';

export type BufferFieldLayoutShape =
  | Readonly<{ kind: 'scalar' }>
  | Readonly<{ kind: 'vector'; length: 2 | 3 | 4 }>
  | Readonly<{
      kind: 'matrix';
      columns: 2 | 3 | 4;
      rows: 2 | 3 | 4;
      columnStride: number;
    }>
  | Readonly<{
      kind: 'array';
      length: number;
      stride: number;
      element: BufferFieldLayoutShape;
    }>;

export interface BufferFieldLayout {
  readonly path: string;
  readonly offset: number;
  readonly size: number;
  readonly alignment: number;
  readonly stride?: number;
  readonly scalarKind: ShaderScalarKind;
  readonly elementCount: number;
  readonly shape: BufferFieldLayoutShape;
}

export interface BufferLayoutManifest {
  readonly name: string;
  readonly shaderAbiVersion: number;
  readonly target: ShaderTarget;
  readonly addressSpace: 'uniform' | 'storage';
  readonly access: 'read' | 'read_write';
  readonly policy: ShaderLayoutPolicyId;
  readonly byteSize: number;
  readonly alignment: number;
  readonly fields: readonly BufferFieldLayout[];
  readonly layoutHash: string;
}

export type ShaderBufferBindingEntryManifest = Readonly<{
  kind: 'uniform-buffer' | 'storage-buffer';
  group: number;
  binding: number;
  name: string;
  bufferLayoutName: string;
}>;

export type ShaderTextureBindingEntryManifest = Readonly<{
  kind: 'texture';
  group: number;
  binding: number;
  name: string;
  viewDimension: '2d' | 'cube';
  sampleType: 'float' | 'depth' | 'uint' | 'sint';
  multisampled: boolean;
}>;

export type ShaderSamplerBindingEntryManifest = Readonly<{
  kind: 'sampler';
  group: number;
  binding: number;
  name: string;
  samplerType: 'filtering' | 'non-filtering' | 'comparison';
}>;

export type ShaderBindingEntryManifest =
  | ShaderBufferBindingEntryManifest
  | ShaderTextureBindingEntryManifest
  | ShaderSamplerBindingEntryManifest;

export interface BindingGroupManifest {
  readonly group: number;
  readonly visibility: readonly ShaderStage[];
  readonly entries: readonly ShaderBindingEntryManifest[];
}

export interface ShaderSamplerBindingRequirement {
  readonly kind: 'sampler';
  readonly group: number;
  readonly binding: number;
  readonly samplerType: 'filtering' | 'non-filtering' | 'comparison';
}

export type ShaderBindingRequirement = ShaderSamplerBindingRequirement;

export interface ShaderBindingManifestOptions {
  readonly bindingRequirements?: readonly ShaderBindingRequirement[];
}

export type ShaderBindingReflectionDiagnosticCode =
  | 'unsupported-binding-type'
  | 'duplicate-reflected-binding'
  | 'duplicate-binding-requirement'
  | 'missing-binding-requirement-target'
  | 'binding-requirement-kind-mismatch'
  | 'binding-requirement-conflict';

export interface ShaderBindingReflectionDiagnostic {
  readonly code: ShaderBindingReflectionDiagnosticCode;
  readonly group: number;
  readonly binding: number;
  readonly name?: string;
  readonly sourceType?: string;
  readonly message: string;
}

export interface ShaderBindingManifest {
  readonly shaderAbiVersion: number;
  readonly groups: readonly BindingGroupManifest[];
  readonly buffers: readonly BufferLayoutManifest[];
  readonly vertexInputs: readonly Readonly<{ location: number; name: string; type: string }>[];
  readonly fragmentOutputs: readonly Readonly<{ location: number; name: string; type: string }>[];
  readonly layoutHash: string;
}
