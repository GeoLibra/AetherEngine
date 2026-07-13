import type { ColorRgba } from './types';

export const Color = Object.freeze({
  srgbChannelToLinear(value: number): number {
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  },

  linearChannelToSrgb(value: number): number {
    return value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
  },

  premultiply(color: ColorRgba): ColorRgba {
    return [color[0] * color[3], color[1] * color[3], color[2] * color[3], color[3]];
  },

  unpremultiply(color: ColorRgba): ColorRgba {
    if (color[3] === 0) {
      return [0, 0, 0, 0];
    }
    const inverse = 1 / color[3];
    return [color[0] * inverse, color[1] * inverse, color[2] * inverse, color[3]];
  }
});
