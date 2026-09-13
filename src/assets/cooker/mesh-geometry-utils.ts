import type {
  Bounds3,
  CanonicalMeshPrimitive,
  CanonicalStandardPbrMaterial,
  TextureUvTransform
} from '../canonical/types';

/**
 * Validates that all UV sets required by the active texture slots in a material
 * are present on the mesh primitive.
 *
 * @throws {Error} If a requested UV set is missing from primitive attributes.
 */
export function validatePrimitiveUvSets(
  primitive: CanonicalMeshPrimitive,
  material?: CanonicalStandardPbrMaterial
): void {
  if (!material) return;

  const slots = [
    material.baseColorTexture,
    material.metallicRoughnessTexture,
    material.normalTexture,
    material.occlusionTexture,
    material.emissiveTexture
  ];

  let needsUv0 = false;
  let needsUv1 = false;

  for (const slot of slots) {
    if (slot !== null && slot !== undefined) {
      const texCoord = slot.texCoord ?? 0;
      if (texCoord === 0) needsUv0 = true;
      if (texCoord === 1) needsUv1 = true;
    }
  }

  if (needsUv0 && !primitive.attributes.some((attr) => attr.semantic === 'texcoord-0')) {
    throw new Error(
      `Mesh primitive with material "${primitive.materialId}" requires UV set 0, but "texcoord-0" attribute is missing (code: gltf-render.missing-uv-set).`
    );
  }

  if (needsUv1 && !primitive.attributes.some((attr) => attr.semantic === 'texcoord-1')) {
    throw new Error(
      `Mesh primitive with material "${primitive.materialId}" requires UV set 1, but "texcoord-1" attribute is missing (code: gltf-render.missing-uv-set).`
    );
  }
}

/** Converts untyped or typed array buffer data to Float32Array safely. */
export function toFloat32Array(
  data: Uint8Array | Float32Array | Uint16Array | Uint32Array
): Float32Array {
  if (data instanceof Float32Array) return data;
  return new Float32Array(data.buffer, data.byteOffset, data.byteLength / 4);
}

/**
 * Computes area-weighted geometric vertex normals from triangle faces.
 */
export function computeGeometricNormals(
  positions: Float32Array,
  vertexCount: number,
  indices?: Uint16Array | Uint32Array
): Float32Array {
  const normals = new Float32Array(vertexCount * 3);

  const getPos = (index: number): [number, number, number] => [
    positions[index * 3]!,
    positions[index * 3 + 1]!,
    positions[index * 3 + 2]!
  ];

  const addNormal = (index: number, x: number, y: number, z: number) => {
    const base = index * 3;
    normals[base] = (normals[base] ?? 0) + x;
    normals[base + 1] = (normals[base + 1] ?? 0) + y;
    normals[base + 2] = (normals[base + 2] ?? 0) + z;
  };

  const triangleCount = indices ? indices.length / 3 : vertexCount / 3;

  for (let t = 0; t < triangleCount; t += 1) {
    const i0 = indices ? indices[t * 3]! : t * 3;
    const i1 = indices ? indices[t * 3 + 1]! : t * 3 + 1;
    const i2 = indices ? indices[t * 3 + 2]! : t * 3 + 2;

    const p0 = getPos(i0);
    const p1 = getPos(i1);
    const p2 = getPos(i2);

    const ax = p1[0] - p0[0];
    const ay = p1[1] - p0[1];
    const az = p1[2] - p0[2];

    const bx = p2[0] - p0[0];
    const by = p2[1] - p0[1];
    const bz = p2[2] - p0[2];

    const nx = ay * bz - az * by;
    const ny = az * bx - ax * bz;
    const nz = ax * by - ay * bx;

    addNormal(i0, nx, ny, nz);
    addNormal(i1, nx, ny, nz);
    addNormal(i2, nx, ny, nz);
  }

  for (let v = 0; v < vertexCount; v += 1) {
    const x = normals[v * 3]!;
    const y = normals[v * 3 + 1]!;
    const z = normals[v * 3 + 2]!;
    const len = Math.hypot(x, y, z);
    if (len > 1e-8) {
      normals[v * 3] = x / len;
      normals[v * 3 + 1] = y / len;
      normals[v * 3 + 2] = z / len;
    } else {
      normals[v * 3] = 0;
      normals[v * 3 + 1] = 1;
      normals[v * 3 + 2] = 0;
    }
  }

  return normals;
}

/**
 * Computes deterministic MikkTSpace-compatible 4-component tangents (xyz = tangent, w = handedness).
 */
export function computeTangents(
  positions: Float32Array,
  normals: Float32Array,
  uvs: Float32Array,
  vertexCount: number,
  indices?: Uint16Array | Uint32Array
): Float32Array {
  const tan1 = new Float32Array(vertexCount * 3);
  const tan2 = new Float32Array(vertexCount * 3);

  const triangleCount = indices ? indices.length / 3 : vertexCount / 3;

  for (let t = 0; t < triangleCount; t += 1) {
    const i0 = indices ? indices[t * 3]! : t * 3;
    const i1 = indices ? indices[t * 3 + 1]! : t * 3 + 1;
    const i2 = indices ? indices[t * 3 + 2]! : t * 3 + 2;

    const x0 = positions[i0 * 3]!,
      y0 = positions[i0 * 3 + 1]!,
      z0 = positions[i0 * 3 + 2]!;
    const x1 = positions[i1 * 3]!,
      y1 = positions[i1 * 3 + 1]!,
      z1 = positions[i1 * 3 + 2]!;
    const x2 = positions[i2 * 3]!,
      y2 = positions[i2 * 3 + 1]!,
      z2 = positions[i2 * 3 + 2]!;

    const u0 = uvs[i0 * 2]!,
      v0 = uvs[i0 * 2 + 1]!;
    const u1 = uvs[i1 * 2]!,
      v1 = uvs[i1 * 2 + 1]!;
    const u2 = uvs[i2 * 2]!,
      v2 = uvs[i2 * 2 + 1]!;

    const x1_0 = x1 - x0,
      y1_0 = y1 - y0,
      z1_0 = z1 - z0;
    const x2_0 = x2 - x0,
      y2_0 = y2 - y0,
      z2_0 = z2 - z0;

    const s1 = u1 - u0,
      t1 = v1 - v0;
    const s2 = u2 - u0,
      t2 = v2 - v0;

    const r = 1.0 / (s1 * t2 - s2 * t1 || 1e-8);
    const sdirX = (t2 * x1_0 - t1 * x2_0) * r;
    const sdirY = (t2 * y1_0 - t1 * y2_0) * r;
    const sdirZ = (t2 * z1_0 - t1 * z2_0) * r;

    const tdirX = (s1 * x2_0 - s2 * x1_0) * r;
    const tdirY = (s1 * y2_0 - s2 * y1_0) * r;
    const tdirZ = (s1 * z2_0 - s2 * z1_0) * r;

    const addTan1 = (idx: number, x: number, y: number, z: number) => {
      const base = idx * 3;
      tan1[base] = (tan1[base] ?? 0) + x;
      tan1[base + 1] = (tan1[base + 1] ?? 0) + y;
      tan1[base + 2] = (tan1[base + 2] ?? 0) + z;
    };
    const addTan2 = (idx: number, x: number, y: number, z: number) => {
      const base = idx * 3;
      tan2[base] = (tan2[base] ?? 0) + x;
      tan2[base + 1] = (tan2[base + 1] ?? 0) + y;
      tan2[base + 2] = (tan2[base + 2] ?? 0) + z;
    };

    addTan1(i0, sdirX, sdirY, sdirZ);
    addTan1(i1, sdirX, sdirY, sdirZ);
    addTan1(i2, sdirX, sdirY, sdirZ);

    addTan2(i0, tdirX, tdirY, tdirZ);
    addTan2(i1, tdirX, tdirY, tdirZ);
    addTan2(i2, tdirX, tdirY, tdirZ);
  }

  const tangents = new Float32Array(vertexCount * 4);

  for (let v = 0; v < vertexCount; v += 1) {
    const nx = normals[v * 3]!,
      ny = normals[v * 3 + 1]!,
      nz = normals[v * 3 + 2]!;
    const tx = tan1[v * 3]!,
      ty = tan1[v * 3 + 1]!,
      tz = tan1[v * 3 + 2]!;

    // Gram-Schmidt orthogonalize: t_ortho = t - n * dot(n, t)
    const dotNT = nx * tx + ny * ty + nz * tz;
    let ox = tx - nx * dotNT;
    let oy = ty - ny * dotNT;
    let oz = tz - nz * dotNT;
    let len = Math.hypot(ox, oy, oz);

    if (len > 1e-8) {
      ox /= len;
      oy /= len;
      oz /= len;

      // Calculate handedness: dot(cross(n, t), tan2) < 0 ? -1 : 1
      const cx = ny * oz - nz * oy;
      const cy = nz * ox - nx * oz;
      const cz = nx * oy - ny * ox;
      const dotB = cx * tan2[v * 3]! + cy * tan2[v * 3 + 1]! + cz * tan2[v * 3 + 2]!;
      const w = dotB < 0 ? -1.0 : 1.0;

      tangents[v * 4] = ox;
      tangents[v * 4 + 1] = oy;
      tangents[v * 4 + 2] = oz;
      tangents[v * 4 + 3] = w;
    } else {
      tangents[v * 4] = 1;
      tangents[v * 4 + 1] = 0;
      tangents[v * 4 + 2] = 0;
      tangents[v * 4 + 3] = 1;
    }
  }

  return tangents;
}

/**
 * Transforms authored vertex tangents under 2D affine UV transform (rotation & reflection).
 * Preserves normal-orthogonality and updates handedness sign so sampled normal maps match TBN.
 */
export function transformAuthoredTangents(
  tangents: Float32Array,
  normals: Float32Array,
  vertexCount: number,
  transform: TextureUvTransform
): Float32Array {
  const sx = transform.scale?.[0] ?? 1;
  const sy = transform.scale?.[1] ?? 1;
  const r = transform.rotation ?? 0;
  if (r === 0 && sx > 0 && sy > 0) {
    return tangents;
  }

  const cosR = Math.cos(r);
  const sinR = Math.sin(r);
  const signSx = sx < 0 ? -1 : 1;
  const signSy = sy < 0 ? -1 : 1;
  const signDet = signSx * signSy;

  const result = new Float32Array(vertexCount * 4);
  for (let v = 0; v < vertexCount; v += 1) {
    const tx = tangents[v * 4]!;
    const ty = tangents[v * 4 + 1]!;
    const tz = tangents[v * 4 + 2]!;
    const w = tangents[v * 4 + 3]!;

    const nx = normals[v * 3]!;
    const ny = normals[v * 3 + 1]!;
    const nz = normals[v * 3 + 2]!;

    // Bitangent B = w * (N x T)
    const cx = ny * tz - nz * ty;
    const cy = nz * tx - nx * tz;
    const cz = nx * ty - ny * tx;
    const bx = w * cx;
    const by = w * cy;
    const bz = w * cz;

    // T' = sign(sx) * cos(r) * T - sign(sy) * sin(r) * B
    const factorT = signSx * cosR;
    const factorB = -signSy * sinR;
    let rx = factorT * tx + factorB * bx;
    let ry = factorT * ty + factorB * by;
    let rz = factorT * tz + factorB * bz;

    // Gram-Schmidt orthogonalize against N
    const dotNR = nx * rx + ny * ry + nz * rz;
    rx -= nx * dotNR;
    ry -= ny * dotNR;
    rz -= nz * dotNR;
    const len = Math.hypot(rx, ry, rz);

    if (len > 1e-8) {
      result[v * 4] = rx / len;
      result[v * 4 + 1] = ry / len;
      result[v * 4 + 2] = rz / len;
    } else {
      result[v * 4] = tx;
      result[v * 4 + 1] = ty;
      result[v * 4 + 2] = tz;
    }
    result[v * 4 + 3] = w * signDet;
  }
  return result;
}

/** Computes tight bounding sphere enclosing vertex positions. */
export function computeBoundingSphere(
  positions: Float32Array,
  vertexCount: number,
  bounds: Bounds3
): {
  center: readonly [number, number, number];
  radius: number;
} {
  const cx = (bounds.min[0] + bounds.max[0]) * 0.5;
  const cy = (bounds.min[1] + bounds.max[1]) * 0.5;
  const cz = (bounds.min[2] + bounds.max[2]) * 0.5;

  let maxDistSq = 0;
  for (let i = 0; i < vertexCount; i += 1) {
    const dx = positions[i * 3]! - cx,
      dy = positions[i * 3 + 1]! - cy,
      dz = positions[i * 3 + 2]! - cz;
    const distSq = dx * dx + dy * dy + dz * dz;
    if (distSq > maxDistSq) maxDistSq = distSq;
  }

  return {
    center: [cx, cy, cz],
    radius: Math.sqrt(maxDistSq) * 1.0001 + 0.0001
  };
}

/** Transforms an array of 2D UV coordinates using an affine transform. */
export function transformUvArray(
  uvs: Float32Array,
  vertexCount: number,
  transform: TextureUvTransform
): Float32Array {
  const sx = transform.scale?.[0] ?? 1;
  const sy = transform.scale?.[1] ?? 1;
  const tx = transform.offset?.[0] ?? 0;
  const ty = transform.offset?.[1] ?? 0;
  const r = transform.rotation ?? 0;
  const cosR = Math.cos(r);
  const sinR = Math.sin(r);
  const m00 = sx * cosR;
  const m01 = -sy * sinR;
  const m10 = sx * sinR;
  const m11 = sy * cosR;

  const result = new Float32Array(vertexCount * 2);
  for (let i = 0; i < vertexCount; i += 1) {
    const u = uvs[i * 2]!;
    const v = uvs[i * 2 + 1]!;
    result[i * 2] = m00 * u + m01 * v + tx;
    result[i * 2 + 1] = m10 * u + m11 * v + ty;
  }
  return result;
}
