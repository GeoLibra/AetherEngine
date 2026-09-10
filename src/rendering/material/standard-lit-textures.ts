import type { RHIDevice, RHISampler, RHITexture, RHITextureView } from '../../rhi/contracts';

export type StandardLitTextureSemantic = 'color' | 'data' | 'normal';

export interface StandardLitResolvedTexture {
  readonly texture: RHITexture;
  readonly semantic: StandardLitTextureSemantic;
}

export interface StandardLitResourceResolver {
  resolveTexture(assetId: string): StandardLitResolvedTexture | undefined;
  resolveSampler(assetId: string): RHISampler | undefined;
}

export interface PreparedStandardLitTextureBindings {
  readonly views: readonly RHITextureView[];
  readonly sampler: RHISampler;
  dispose(): void;
}

const BUILTIN_TEXTURES = Object.freeze({
  'aether.texture.white-srgb': { semantic: 'color', rgba: [255, 255, 255, 255] },
  'aether.texture.white-data': { semantic: 'data', rgba: [255, 255, 255, 255] },
  'aether.texture.flat-normal': { semantic: 'normal', rgba: [128, 128, 255, 255] },
  'aether.texture.black-srgb': { semantic: 'color', rgba: [0, 0, 0, 255] }
} as const);

const TEXTURE_USAGE = (1 << 1) | (1 << 2);

/** Resolves and validates the six immutable StandardLit material resources. */
export function prepareStandardLitTextureBindings(input: {
  readonly device: RHIDevice;
  readonly textureIds: readonly [string, string, string, string, string];
  readonly samplerId: string;
  readonly resolver?: StandardLitResourceResolver;
}): PreparedStandardLitTextureBindings {
  const expected: readonly StandardLitTextureSemantic[] = [
    'color',
    'data',
    'normal',
    'data',
    'color'
  ];
  const ownedTextures: RHITexture[] = [];
  const views: RHITextureView[] = [];
  let ownedSampler: RHISampler | undefined;
  try {
    for (let index = 0; index < input.textureIds.length; index += 1) {
      const assetId = input.textureIds[index]!;
      const builtin = BUILTIN_TEXTURES[assetId as keyof typeof BUILTIN_TEXTURES];
      const resolved = builtin === undefined ? input.resolver?.resolveTexture(assetId) : undefined;
      const texture =
        resolved?.texture ?? createBuiltinTexture(input.device, assetId, builtin, ownedTextures);
      const semantic = resolved?.semantic ?? builtin?.semantic;
      if (texture === undefined || semantic === undefined)
        throw new Error(`Standard-lit texture "${assetId}" is not ready.`);
      if (semantic !== expected[index])
        throw new Error(
          `Standard-lit texture "${assetId}" has incompatible ${semantic} semantics.`
        );
      assertLiveGeneration(texture, input.device.generation, assetId);
      views.push(texture.createView());
    }
    const resolvedSampler = input.resolver?.resolveSampler(input.samplerId);
    const sampler =
      resolvedSampler ??
      (input.samplerId === 'aether.sampler.linear-repeat'
        ? (ownedSampler = input.device.createSampler({
            minFilter: 'linear',
            magFilter: 'linear',
            mipmapFilter: 'linear',
            addressModeU: 'repeat',
            addressModeV: 'repeat'
          }))
        : undefined);
    if (sampler === undefined)
      throw new Error(`Standard-lit sampler "${input.samplerId}" is not ready.`);
    assertLiveGeneration(sampler, input.device.generation, input.samplerId);
    return Object.freeze({
      views: Object.freeze(views),
      sampler,
      dispose() {
        for (const view of [...views].reverse()) view.dispose();
        for (const texture of [...ownedTextures].reverse()) texture.dispose();
        ownedSampler?.dispose();
      }
    });
  } catch (error) {
    for (const view of [...views].reverse()) view.dispose();
    for (const texture of [...ownedTextures].reverse()) texture.dispose();
    ownedSampler?.dispose();
    throw error;
  }
}

function createBuiltinTexture(
  device: RHIDevice,
  assetId: string,
  builtin: (typeof BUILTIN_TEXTURES)[keyof typeof BUILTIN_TEXTURES] | undefined,
  owned: RHITexture[]
): RHITexture | undefined {
  if (builtin === undefined) return undefined;
  const texture = device.createTexture({
    label: assetId,
    size: [1, 1],
    format: 'rgba8unorm',
    usage: TEXTURE_USAGE
  });
  owned.push(texture);
  device.queue.writeTexture(
    { texture },
    new Uint8Array(builtin.rgba),
    { bytesPerRow: 4, rowsPerImage: 1 },
    { width: 1, height: 1 }
  );
  return texture;
}

function assertLiveGeneration(
  resource: { readonly state: string; readonly generation: number },
  generation: number,
  assetId: string
): void {
  if (resource.state !== 'live' || resource.generation !== generation)
    throw new Error(`Standard-lit resource "${assetId}" belongs to a stale device generation.`);
}
