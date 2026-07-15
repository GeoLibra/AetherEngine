import type { RHIShaderModule } from '../contracts/resource';

export type WebGL2ShaderStage = 'vertex' | 'fragment';
export type WebGL2BindingKind = 'uniform-buffer' | 'texture' | 'sampler';

export interface WebGL2BindingManifestEntry {
  readonly group: number;
  readonly binding: number;
  readonly name: string;
  readonly kind: WebGL2BindingKind;
}

export interface WebGL2TranslatedShader {
  readonly source: string;
  readonly bindings: readonly WebGL2BindingManifestEntry[];
}

export interface WebGL2ShaderTranslationPort {
  translate(input: {
    readonly module: RHIShaderModule;
    readonly stage: WebGL2ShaderStage;
    readonly entryPoint: string;
    readonly constants: Readonly<Record<string, number>>;
  }): WebGL2TranslatedShader;
}
