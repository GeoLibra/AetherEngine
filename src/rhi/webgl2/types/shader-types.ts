import type { WebGL2ClipDepthMode } from '../clip-depth';

export type WebGL2ShaderStage = 'vertex' | 'fragment';
export type WebGL2BindingKind = 'uniform-buffer' | 'texture' | 'sampler';

export interface WebGL2BindingManifestEntry {
  readonly group: number;
  readonly binding: number;
  readonly name: string;
  readonly kind: WebGL2BindingKind;
}

export interface WebGL2PhysicalBinding {
  readonly group: number;
  readonly binding: number;
  readonly kind: WebGL2BindingKind;
  readonly slot: number;
}

export interface WebGL2TranslatedShader {
  readonly source: string;
  readonly bindings: readonly WebGL2BindingManifestEntry[];
  readonly targetAbiFingerprint: string;
  readonly physicalBindings: readonly WebGL2PhysicalBinding[];
  readonly requiredExtensions: readonly string[];
  readonly sourceMap: readonly Readonly<{ generatedLine: number; authoredLine: number }>[];
  readonly translatorFingerprint: string;
}

export interface WebGL2ShaderTranslationPort {
  readonly translatorId: string;
  readonly version: number;
  translate(
    input: Readonly<{
      wgsl: string;
      stage: WebGL2ShaderStage;
      entryPoint: string;
      constants: Readonly<Record<string, number>>;
      capabilities: readonly string[];
      approvedExtensions: readonly string[];
      clipDepthMode: WebGL2ClipDepthMode;
    }>
  ): WebGL2TranslatedShader;
}

export interface FinalizedWebGL2Shader extends WebGL2TranslatedShader {
  readonly source: string;
  readonly finalFingerprint: string;
}
