import type { ColorRgba } from './types';

export const Color = {
  /**
   * Converts an sRGB color channel value to linear color space.
   *
   * @param value - Normalized sRGB channel component in range [0, 1].
   * @returns The linear color space component.
   */
  srgbChannelToLinear(value: number): number {
    return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  },

  /**
   * Converts a linear color channel value to sRGB color space.
   *
   * @param value - Normalized linear channel component in range [0, 1].
   * @returns The sRGB color space component.
   */
  linearChannelToSrgb(value: number): number {
    return value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
  },

  /**
   * Converts a straight RGBA color to premultiplied alpha format.
   *
   * Multiplies the RGB components by the alpha channel ([R * A, G * A, B * A, A]).
   *
   * @param color - Straight RGBA color vector with normalized [0, 1] components.
   * @returns A new RGBA color vector in premultiplied format.
   */
  premultiply(color: ColorRgba): ColorRgba {
    return [color[0] * color[3], color[1] * color[3], color[2] * color[3], color[3]];
  },

  /**
   * Converts a premultiplied RGBA color back to straight alpha format.
   *
   * Divides the RGB components by the alpha channel ([R / A, G / A, B / A, A]).
   * Returns an all-zero vector `[0, 0, 0, 0]` when alpha is zero to safely prevent division by zero.
   *
   * @param color - Premultiplied RGBA color vector with normalized [0, 1] components.
   * @returns A new RGBA color vector in straight alpha format.
   */
  unpremultiply(color: ColorRgba): ColorRgba {
    if (color[3] === 0) {
      return [0, 0, 0, 0];
    }
    const inverse = 1 / color[3];
    return [color[0] * inverse, color[1] * inverse, color[2] * inverse, color[3]];
  }
};
