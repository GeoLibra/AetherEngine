import type { BufferRange, TextureRange } from '../../types';

export interface TextureGraphRange extends TextureRange {
  readonly kind: 'texture';
  readonly mipLevelEnd: number;
  readonly arrayLayerEnd: number;
}

export interface BufferGraphRange extends BufferRange {
  readonly kind: 'buffer';
  readonly end: number;
}

export type GraphRange = TextureGraphRange | BufferGraphRange;
