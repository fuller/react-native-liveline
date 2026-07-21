import type { SkColor } from '@shopify/react-native-skia';

/**
 * Builds an SkColor (Float32Array RGBA) directly from 0-255 RGB components
 * and 0-1 alpha — skips both the `rgb()`/`rgba()` string-formatting step and
 * the native `Skia.Color()` string-parse call that animated color blends
 * previously round-tripped through every frame. Cheaper than even a
 * color-cache hit (no lookup at all) and exact (no snapping to a string and
 * back).
 *
 * Type-only Skia import — `Float32Array` is a JS global, so this stays
 * runtime-Skia-free and testable with jest like the rest of `src/math`.
 */
export function rgbColor(
  r: number,
  g: number,
  b: number,
  a: number = 1
): SkColor {
  'worklet';
  return new Float32Array([r / 255, g / 255, b / 255, a]);
}
