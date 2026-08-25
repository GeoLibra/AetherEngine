export type CanonicalKeyHasher = (canonicalValue: string) => string;

declare const canonicalKeyBrand: unique symbol;

export interface CanonicalKey<P> {
  readonly [canonicalKeyBrand]: true;
  readonly canonicalValue: string;
  readonly hash: string;
  readonly parts: Readonly<P>;
}

export interface PipelineKeyParts {
  readonly shaderModuleKey: string;
  readonly entryPoints: readonly Readonly<{
    stage: 'vertex' | 'fragment';
    name: string;
  }>[];
  readonly bindingLayoutHash: string;
  readonly vertexLayoutHash: string;
  readonly primitiveStateHash: string;
  readonly depthStencilStateHash: string;
  readonly blendStateHash: string;
  readonly attachmentFormats: readonly string[];
  readonly depthStencilFormat?: string;
  readonly sampleCount: number;
  readonly featurePolicyHash: string;
  readonly deviceGeneration: number;
}

export interface BindingResourceKeyParts {
  readonly group: number;
  readonly binding: number;
  readonly assetId: string;
  readonly assetPayloadVersion: number;
  readonly resourceGeneration: number;
}

export interface BindingKeyParts {
  readonly bindingLayoutHash: string;
  readonly resources: readonly Readonly<BindingResourceKeyParts>[];
  readonly bufferAllocationGeneration: number;
  readonly ringGeneration: number;
  readonly dynamicOffsets: readonly number[];
  readonly deviceGeneration: number;
}
