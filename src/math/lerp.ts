/**
 * Frame-rate-independent exponential lerp.
 * `speed` is the fraction approached per 16.67ms (60fps frame).
 * At lower frame rates, dt is larger so we approach more per frame.
 */
export function lerp(
  current: number,
  target: number,
  speed: number,
  dt = 16.67
): number {
  'worklet';
  // Convert per-frame speed to continuous decay factor
  const factor = 1 - Math.pow(1 - speed, dt / 16.67);
  return current + (target - current) * factor;
}

/**
 * Snaps a continuously-animating 0-1 blend factor to `1/steps` increments.
 * Used before formatting a lerped value into an `rgb()`/`rgba()` string so
 * the string (and its entry in the Canvas2D shim's color cache) repeats
 * across frames instead of missing the cache on every frame of the
 * animation — visually lossless at the default 64 steps.
 */
export function quantize(t: number, steps = 64): number {
  'worklet';
  return Math.round(t * steps) / steps;
}
