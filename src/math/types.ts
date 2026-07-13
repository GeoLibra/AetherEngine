export type Vec3 = readonly [number, number, number];
export type Vec4 = readonly [number, number, number, number];
export type Quaternion = readonly [number, number, number, number];
export type EulerYXZ = readonly [
  xRadians: number,
  yRadians: number,
  zRadians: number
];
export type ColorRgba = readonly [number, number, number, number];

export interface ViewportRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Plane {
  readonly normal: Vec3;
  readonly distance: number;
}

export type DepthConvention =
  | {
      readonly mode: 'standard';
      readonly clear: 1;
      readonly compare: 'less' | 'less-equal';
    }
  | {
      readonly mode: 'reverse';
      readonly clear: 0;
      readonly compare: 'greater' | 'greater-equal';
    };
