const DEGREES_PER_RADIAN = 180 / Math.PI;

export function degreesToRadians(degrees: number): number {
  assertFiniteAngle(degrees);
  return degrees / DEGREES_PER_RADIAN;
}

export function radiansToDegrees(radians: number): number {
  assertFiniteAngle(radians);
  return radians * DEGREES_PER_RADIAN;
}

function assertFiniteAngle(value: number): void {
  if (!Number.isFinite(value)) {
    throw new Error('Angle must be finite.');
  }
}
