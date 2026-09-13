import type { World } from '../../ecs/world';
import type { Entity } from '../../ecs/types';
import { LocalTransform, WorldTransform } from '../../transform';
import { MeshRenderSource } from '../../rendering/mesh/mesh-render-source';
import type {
  CanonicalNodeDocument,
  CanonicalSceneDocument,
  CanonicalTransform
} from '../canonical/types';
import type { CookedMeshArtifact, CookedSceneArtifact, CookedSceneNode } from './types';
import { MaterialAssetType, MeshAssetType } from '../asset-handle';
import type { MeshRenderSourceView } from '../../rendering/mesh/types';

/**
 * Computes world transform matrices down the canonical node hierarchy.
 */
export function cookCanonicalScene(scene: CanonicalSceneDocument): CookedSceneArtifact {
  const nodeCount = scene.nodes.length;
  const localMatrices: number[][] = [];

  for (let i = 0; i < nodeCount; i += 1) {
    const node = scene.nodes[i]!;
    localMatrices.push(transformToMatrix(node.transform));
  }

  const worldMatrices: number[][] = new Array(nodeCount);

  function computeNodeWorld(index: number, parentWorld: number[] | null): void {
    const local = localMatrices[index]!;
    const world = parentWorld ? multiplyMat4(parentWorld, local) : [...local];
    worldMatrices[index] = world;

    const node = scene.nodes[index]!;
    for (const childIndex of node.children) {
      computeNodeWorld(childIndex, world);
    }
  }

  for (const rootIndex of scene.rootNodes) {
    computeNodeWorld(rootIndex, null);
  }

  const cookedNodes: CookedSceneNode[] = scene.nodes.map((node, i) => ({
    nodeIndex: i,
    ...(node.name ? { name: node.name } : {}),
    localTransform: localMatrices[i]!,
    worldTransform: worldMatrices[i] ?? localMatrices[i]!,
    ...(node.meshId ? { meshId: node.meshId } : {}),
    children: node.children
  }));

  return {
    id: scene.id,
    kind: 'scene',
    version: scene.version,
    nodes: cookedNodes,
    rootNodes: scene.rootNodes,
    defaultSceneIndex: scene.defaultSceneIndex ?? 0
  };
}

/**
 * Spawns ECS entities for all nodes in the scene's reachable root subtree that have renderable meshes.
 * Nodes not reachable from `scene.rootNodes` (e.g. from other glTF scenes or detached nodes) are excluded.
 */
export function instantiateCookedScene(
  scene: CookedSceneArtifact,
  meshArtifacts: ReadonlyMap<string, CookedMeshArtifact>,
  world: World
): readonly Entity[] {
  const spawnedEntities: Entity[] = [];

  // Collect reachable node indices starting from rootNodes
  const reachableNodeIndices = new Set<number>();
  const queue = [...scene.rootNodes];
  while (queue.length > 0) {
    const idx = queue.shift()!;
    if (reachableNodeIndices.has(idx)) continue;
    reachableNodeIndices.add(idx);
    const node = scene.nodes[idx];
    if (node && Array.isArray(node.children)) {
      for (const childIdx of node.children) {
        if (!reachableNodeIndices.has(childIdx)) {
          queue.push(childIdx);
        }
      }
    }
  }

  for (let i = 0; i < scene.nodes.length; i += 1) {
    if (!reachableNodeIndices.has(i)) continue;
    const node = scene.nodes[i]!;
    if (!node.meshId) continue;
    const meshArtifact = meshArtifacts.get(node.meshId);
    if (!meshArtifact) continue;

    for (let primIdx = 0; primIdx < meshArtifact.primitives.length; primIdx += 1) {
      const prim = meshArtifact.primitives[primIdx]!;
      // Decompose world transform matrix into translation, rotation, scale
      const trs = decomposeMatrix(node.worldTransform);
      const renderSourceView: MeshRenderSourceView = {
        mesh: {
          handle: { assetId: meshArtifact.id, type: MeshAssetType },
          payloadVersion: meshArtifact.version
        },
        submesh: primIdx,
        materials: prim.materialId
          ? [
              {
                slot: 0,
                handle: { assetId: prim.materialId, type: MaterialAssetType },
                payloadVersion: 1
              }
            ]
          : [],
        localBounds: {
          aabb: prim.meshData.bounds.aabb,
          sphere: prim.meshData.bounds.sphere
        },
        visible: true,
        layerMask: 1
      };

      const det =
        node.worldTransform[0]! *
          (node.worldTransform[5]! * node.worldTransform[10]! -
            node.worldTransform[6]! * node.worldTransform[9]!) -
        node.worldTransform[1]! *
          (node.worldTransform[4]! * node.worldTransform[10]! -
            node.worldTransform[6]! * node.worldTransform[8]!) +
        node.worldTransform[2]! *
          (node.worldTransform[4]! * node.worldTransform[9]! -
            node.worldTransform[5]! * node.worldTransform[8]!);

      const entity = world
        .spawn()
        .insert(LocalTransform, {
          translation: trs.translation,
          rotation: trs.rotation,
          scale: trs.scale,
          localVersion: 1
        })
        .insert(WorldTransform, {
          matrix: new Float32Array(node.worldTransform),
          previousMatrix: new Float32Array(node.worldTransform),
          normalMatrix: new Float32Array(computeUpper3x3NormalMatrix(node.worldTransform)),
          worldVersion: 1,
          originCell: [0, 0, 0],
          determinantSign: det >= 0 ? 1 : -1
        })
        .insert(MeshRenderSource, renderSourceView as unknown as Record<string, unknown>)
        .build();

      spawnedEntities.push(entity);
    }
  }

  return spawnedEntities;
}

function transformToMatrix(transform: CanonicalTransform): number[] {
  if (transform.kind === 'matrix') {
    return [...transform.matrix];
  }

  const [tx, ty, tz] = transform.translation;
  const [qx, qy, qz, qw] = transform.rotation;
  const [sx, sy, sz] = transform.scale;

  const x2 = qx + qx,
    y2 = qy + qy,
    z2 = qz + qz;
  const xx = qx * x2,
    xy = qx * y2,
    xz = qx * z2;
  const yy = qy * y2,
    yz = qy * z2,
    zz = qz * z2;
  const wx = qw * x2,
    wy = qw * y2,
    wz = qw * z2;

  // Column-major 4x4 matrix
  return [
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    tx,
    ty,
    tz,
    1
  ];
}

function multiplyMat4(a: readonly number[], b: readonly number[]): number[] {
  const out = new Array<number>(16);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      out[col * 4 + row] =
        a[0 * 4 + row]! * b[col * 4 + 0]! +
        a[1 * 4 + row]! * b[col * 4 + 1]! +
        a[2 * 4 + row]! * b[col * 4 + 2]! +
        a[3 * 4 + row]! * b[col * 4 + 3]!;
    }
  }
  return out;
}

function decomposeMatrix(m: readonly number[]): {
  translation: [number, number, number];
  rotation: [number, number, number, number];
  scale: [number, number, number];
} {
  const translation: [number, number, number] = [m[12]!, m[13]!, m[14]!];

  let sx = Math.hypot(m[0]!, m[1]!, m[2]!);
  let sy = Math.hypot(m[4]!, m[5]!, m[6]!);
  let sz = Math.hypot(m[8]!, m[9]!, m[10]!);

  // Check determinant to preserve negative scale
  const det =
    m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) -
    m[1]! * (m[4]! * m[10]! - m[6]! * m[8]!) +
    m[2]! * (m[4]! * m[9]! - m[5]! * m[8]!);
  if (det < 0) {
    sx = -sx;
  }

  const isx = sx !== 0 ? 1 / sx : 0;
  const isy = sy !== 0 ? 1 / sy : 0;
  const isz = sz !== 0 ? 1 / sz : 0;

  const r00 = m[0]! * isx,
    r01 = m[4]! * isy,
    r02 = m[8]! * isz;
  const r10 = m[1]! * isx,
    r11 = m[5]! * isy,
    r12 = m[9]! * isz;
  const r20 = m[2]! * isx,
    r21 = m[6]! * isy,
    r22 = m[10]! * isz;

  const trace = r00 + r11 + r22;
  let qx = 0,
    qy = 0,
    qz = 0,
    qw = 1;

  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1.0);
    qw = 0.25 / s;
    qx = (r21 - r12) * s;
    qy = (r02 - r20) * s;
    qz = (r10 - r01) * s;
  } else if (r00 > r11 && r00 > r22) {
    const s = 2.0 * Math.sqrt(1.0 + r00 - r11 - r22);
    qw = (r21 - r12) / s;
    qx = 0.25 * s;
    qy = (r01 + r10) / s;
    qz = (r02 + r20) / s;
  } else if (r11 > r22) {
    const s = 2.0 * Math.sqrt(1.0 + r11 - r00 - r22);
    qw = (r02 - r20) / s;
    qx = (r01 + r10) / s;
    qy = 0.25 * s;
    qz = (r12 + r21) / s;
  } else {
    const s = 2.0 * Math.sqrt(1.0 + r22 - r00 - r11);
    qw = (r10 - r01) / s;
    qx = (r02 + r20) / s;
    qy = (r12 + r21) / s;
    qz = 0.25 * s;
  }

  return {
    translation,
    rotation: [qx, qy, qz, qw],
    scale: [sx, sy, sz]
  };
}

function computeUpper3x3NormalMatrix(m: readonly number[]): number[] {
  const a00 = m[0]!,
    a01 = m[4]!,
    a02 = m[8]!;
  const a10 = m[1]!,
    a11 = m[5]!,
    a12 = m[9]!;
  const a20 = m[2]!,
    a21 = m[6]!,
    a22 = m[10]!;

  const b01 = a22 * a11 - a12 * a21;
  const b11 = -a22 * a10 + a12 * a20;
  const b21 = a21 * a10 - a11 * a20;

  const det = a00 * b01 + a01 * b11 + a02 * b21;
  if (Math.abs(det) < 1e-8) {
    return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  }
  const invDet = 1.0 / det;

  return [
    b01 * invDet,
    (-a22 * a01 + a02 * a21) * invDet,
    (a12 * a01 - a02 * a11) * invDet,
    b11 * invDet,
    (a22 * a00 - a02 * a20) * invDet,
    (-a12 * a00 + a02 * a10) * invDet,
    b21 * invDet,
    (-a21 * a00 + a01 * a20) * invDet,
    (a11 * a00 - a01 * a10) * invDet
  ];
}
