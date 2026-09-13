import type { CanonicalNodeDocument, CanonicalTransform } from '../../canonical/types';
import type { AssetId } from '../../types';

export interface GltfNodeContext {
  readonly assetPrefix: string;
}

/**
 * Unpacks glTF nodes and validates transform invariants and hierarchy cycles.
 */
export function unpackGltfNodes(
  gltfNodes: readonly Record<string, any>[],
  context: GltfNodeContext
): readonly CanonicalNodeDocument[] {
  const result: CanonicalNodeDocument[] = [];

  for (let i = 0; i < gltfNodes.length; i += 1) {
    const rawNode = gltfNodes[i]!;
    const transform = parseNodeTransform(rawNode, i);
    const children = Array.isArray(rawNode.children) ? (rawNode.children as number[]) : [];
    const meshId =
      rawNode.mesh !== undefined
        ? (`${context.assetPrefix}:mesh:${rawNode.mesh}` as AssetId)
        : undefined;

    result.push(
      Object.freeze({
        ...(rawNode.name ? { name: rawNode.name } : {}),
        transform,
        ...(meshId ? { meshId } : {}),
        children: Object.freeze([...children]),
        ...(rawNode.camera !== undefined ? { cameraIndex: rawNode.camera } : {}),
        ...(rawNode.skin !== undefined ? { skinIndex: rawNode.skin } : {})
      })
    );
  }

  // Validate cycle invariants
  validateNodeHierarchyAcyclic(result);

  return Object.freeze(result);
}

function parseNodeTransform(node: Record<string, any>, nodeIndex: number): CanonicalTransform {
  const hasMatrix = node.matrix !== undefined;
  const hasTrs =
    node.translation !== undefined || node.rotation !== undefined || node.scale !== undefined;

  if (hasMatrix && hasTrs) {
    throw new Error(
      `glTF node ${nodeIndex} illegally defines both matrix and TRS transform components.`
    );
  }

  if (hasMatrix) {
    if (!Array.isArray(node.matrix) || node.matrix.length !== 16) {
      throw new Error(`glTF node ${nodeIndex} matrix must contain exactly 16 numbers.`);
    }
    for (let i = 0; i < 16; i += 1) {
      if (!Number.isFinite(node.matrix[i])) {
        throw new Error(`glTF node ${nodeIndex} matrix contains non-finite values at index ${i}.`);
      }
    }
    return Object.freeze({
      kind: 'matrix',
      matrix: Object.freeze([...node.matrix])
    });
  }

  const translation = (node.translation ?? [0, 0, 0]) as [number, number, number];
  const rotation = (node.rotation ?? [0, 0, 0, 1]) as [number, number, number, number];
  const scale = (node.scale ?? [1, 1, 1]) as [number, number, number];

  for (let i = 0; i < 3; i += 1) {
    if (!Number.isFinite(translation[i]))
      throw new Error(`Node ${nodeIndex} translation[${i}] is non-finite.`);
    if (!Number.isFinite(scale[i])) throw new Error(`Node ${nodeIndex} scale[${i}] is non-finite.`);
  }
  for (let i = 0; i < 4; i += 1) {
    if (!Number.isFinite(rotation[i]))
      throw new Error(`Node ${nodeIndex} rotation[${i}] is non-finite.`);
  }

  return Object.freeze({
    kind: 'trs',
    translation: Object.freeze([translation[0], translation[1], translation[2]]) as readonly [
      number,
      number,
      number
    ],
    rotation: Object.freeze([rotation[0], rotation[1], rotation[2], rotation[3]]) as readonly [
      number,
      number,
      number,
      number
    ],
    scale: Object.freeze([scale[0], scale[1], scale[2]]) as readonly [number, number, number]
  });
}

function validateNodeHierarchyAcyclic(nodes: readonly CanonicalNodeDocument[]): void {
  const visited = new Uint8Array(nodes.length); // 0 = unvisited, 1 = visiting (on stack), 2 = visited

  function visit(index: number): void {
    if (visited[index] === 1) {
      throw new Error(`Cycle detected in node hierarchy at node index ${index}.`);
    }
    if (visited[index] === 2) return;

    visited[index] = 1;
    const node = nodes[index]!;
    for (const child of node.children) {
      if (child < 0 || child >= nodes.length) {
        throw new Error(`Node ${index} references invalid child index ${child}.`);
      }
      visit(child);
    }
    visited[index] = 2;
  }

  for (let i = 0; i < nodes.length; i += 1) {
    if (visited[i] === 0) visit(i);
  }
}
