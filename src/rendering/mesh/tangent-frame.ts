export interface TangentFrameTransformInput {
  /** Object-space unit normal. */
  readonly normal: readonly [number, number, number];
  /** Object-space MikkTSpace tangent with authored handedness in w. */
  readonly tangent: readonly [number, number, number, 1 | -1];
  /** Row-major upper 3x3 world transform. */
  readonly worldMatrix: readonly number[];
  /** Row-major inverse-transpose upper 3x3 world transform. */
  readonly normalMatrix: readonly number[];
}

export interface WorldTangentFrame {
  readonly normal: readonly [number, number, number];
  readonly tangent: readonly [number, number, number];
  readonly bitangent: readonly [number, number, number];
}

/** Builds the world-space MikkTSpace frame, including mirrored-transform handedness. */
export function transformTangentFrame(input: TangentFrameTransformInput): WorldTangentFrame {
  requireMatrix(input.worldMatrix, 'worldMatrix');
  requireMatrix(input.normalMatrix, 'normalMatrix');
  const normal = normalize(transform(input.normalMatrix, input.normal), 'normal');
  const rawTangent = transform(input.worldMatrix, input.tangent);
  const projection = dot(rawTangent, normal);
  const tangent = normalize(
    [
      rawTangent[0] - normal[0] * projection,
      rawTangent[1] - normal[1] * projection,
      rawTangent[2] - normal[2] * projection
    ],
    'tangent'
  );
  const transformSign = determinant(input.worldMatrix) < 0 ? -1 : 1;
  const handedness = input.tangent[3] * transformSign;
  const bitangent = cross(normal, tangent).map((value) => clean(value * handedness)) as [
    number,
    number,
    number
  ];
  return Object.freeze({
    normal: Object.freeze(normal.map(clean) as [number, number, number]),
    tangent: Object.freeze(tangent.map(clean) as [number, number, number]),
    bitangent: Object.freeze(bitangent)
  });
}

function transform(matrix: readonly number[], vector: readonly number[]): [number, number, number] {
  return [
    matrix[0]! * vector[0]! + matrix[1]! * vector[1]! + matrix[2]! * vector[2]!,
    matrix[3]! * vector[0]! + matrix[4]! * vector[1]! + matrix[5]! * vector[2]!,
    matrix[6]! * vector[0]! + matrix[7]! * vector[1]! + matrix[8]! * vector[2]!
  ];
}

function normalize(vector: [number, number, number], label: string): [number, number, number] {
  const length = Math.hypot(...vector);
  if (!Number.isFinite(length) || length <= Number.EPSILON) {
    throw new Error(`Standard-lit ${label} cannot form a finite tangent frame.`);
  }
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

function cross(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [
    a[1]! * b[2]! - a[2]! * b[1]!,
    a[2]! * b[0]! - a[0]! * b[2]!,
    a[0]! * b[1]! - a[1]! * b[0]!
  ];
}

function determinant(m: readonly number[]): number {
  return (
    m[0]! * (m[4]! * m[8]! - m[5]! * m[7]!) -
    m[1]! * (m[3]! * m[8]! - m[5]! * m[6]!) +
    m[2]! * (m[3]! * m[7]! - m[4]! * m[6]!)
  );
}

function requireMatrix(matrix: readonly number[], label: string): void {
  if (matrix.length !== 9 || matrix.some((value) => !Number.isFinite(value))) {
    throw new Error(`Standard-lit ${label} must contain nine finite values.`);
  }
  if (Math.abs(determinant(matrix)) <= Number.EPSILON) {
    throw new Error(`Standard-lit ${label} must be invertible.`);
  }
}

function clean(value: number): number {
  return Object.is(value, -0) ? 0 : value;
}
