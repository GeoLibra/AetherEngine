import type { ShaderTarget } from './types';

export type ShaderLayoutPolicyId = 'wgsl-uniform' | 'wgsl-storage' | 'glsl-std140';

export interface ShaderLayoutPolicy {
  readonly id: ShaderLayoutPolicyId;
  readonly target: ShaderTarget;
  readonly addressSpace: 'uniform' | 'storage';
  structAlignment(memberAlignment: number): number;
  arrayAlignment(elementAlignment: number): number;
  arrayStride(elementSize: number, elementAlignment: number): number;
  matrixColumnStride(rowCount: number): number;
}

const POLICIES: Readonly<Record<ShaderLayoutPolicyId, ShaderLayoutPolicy>> = Object.freeze({
  'wgsl-uniform': createPolicy('wgsl-uniform', 'wgsl', 'uniform', true, false),
  'wgsl-storage': createPolicy('wgsl-storage', 'wgsl', 'storage', false, false),
  'glsl-std140': createPolicy('glsl-std140', 'glsl300es', 'uniform', true, true)
});

export function shaderLayoutPolicy(id: ShaderLayoutPolicyId): ShaderLayoutPolicy {
  return POLICIES[id];
}

export function selectShaderLayoutPolicy(
  target: ShaderTarget,
  addressSpace: 'uniform' | 'storage'
): ShaderLayoutPolicy {
  if (target === 'glsl300es') {
    if (addressSpace === 'storage') {
      throw new Error('WebGL2 does not support storage-buffer shader ABI layouts.');
    }
    return POLICIES['glsl-std140'];
  }
  return addressSpace === 'uniform' ? POLICIES['wgsl-uniform'] : POLICIES['wgsl-storage'];
}

function createPolicy(
  id: ShaderLayoutPolicyId,
  target: ShaderTarget,
  addressSpace: 'uniform' | 'storage',
  roundAggregatesTo16: boolean,
  std140Matrices: boolean
): ShaderLayoutPolicy {
  const aggregateAlignment = (alignment: number) =>
    roundAggregatesTo16 ? Math.max(16, alignment) : alignment;
  return Object.freeze({
    id,
    target,
    addressSpace,
    structAlignment: aggregateAlignment,
    arrayAlignment: aggregateAlignment,
    arrayStride: (size: number, alignment: number) => align(size, aggregateAlignment(alignment)),
    matrixColumnStride: (rows: number) => (std140Matrices ? 16 : rows === 2 ? 8 : 16)
  });
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment;
}
